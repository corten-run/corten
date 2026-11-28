//! Pages and patches: what a handler returns and how it reaches each kind of client.

use std::{
    cell::Cell,
    convert::Infallible,
    future::Future,
    hash::{Hash, Hasher},
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, LazyLock,
    },
};

use crate::body::Body;
use crate::extract::FromRequestParts;
use crate::handler::Request;
use crate::response::IntoResponse;
use crate::response::Response;
use http::header;
use http::request::Parts;
use http::Extensions;
use http::HeaderMap;
use http::HeaderName;
use http::HeaderValue;
use http::StatusCode;
use http::Uri;

use crate::{
    answer::{HtmlResponse, HtmlResult},
    app::{Inbound, Next},
    assets::Assets,
    extract::{Over, Waited},
    security::NonceSlot,
    view::{html, Document, Part, Render},
    Error, Result,
};

/// Request header the runtime sets: `nav` for navigations, `action` for form submits, `page` for
/// the whole page it fetches after a write.
pub const MODE_HEADER: HeaderName = HeaderName::from_static("corten");
/// `Prefer` (RFC 7240), the request header in which a runtime that draws a write's own page whole
/// says so with each form submit: `Prefer: corten-draws=whole` ([`DRAWS_WHOLE`]). A write the
/// runtime sent without it (a tab whose runtime predates this, open across a deploy) gets its own
/// page as `<main>`, which such a runtime swaps in; a whole page it would take for an answer it
/// cannot draw (#1370). A server that predates it (a fleet halfway through a deploy) ignores a
/// preference it does not know, as RFC 7240 asks, and reads `corten: action` as it always did.
pub(crate) const PREFER: HeaderName = HeaderName::from_static("prefer");
/// The preference a runtime that draws a write's own page whole sends in [`PREFER`].
pub(crate) const DRAWS_WHOLE: &str = "corten-draws=whole";
pub(crate) const PAGE_HEADER: HeaderName = HeaderName::from_static("corten-page");
pub(crate) const PATCH_HEADER: HeaderName = HeaderName::from_static("corten-patch");
pub(crate) const LOCATION_HEADER: HeaderName = HeaderName::from_static("corten-location");
pub(crate) const SHELL_HEADER: HeaderName = HeaderName::from_static("corten-shell");
/// A navigation's page with a notice: `m=<text>`, form-encoded, and `&d` when the page drew it.
pub(crate) const NOTICE_HEADER: HeaderName = HeaderName::from_static("corten-notice");
/// The cookie a redirect's notice rides in: `__Host-`, so no other site on the domain can set it.
pub(crate) const NOTICE_COOKIE: &str = "__Host-corten-notice";
/// The notice's cookie for a write from a plain `http://` origin that is not loopback (a LAN
/// tool), which refuses a `Secure` cookie and so a `__Host-` one: read only from a request without
/// `Sec-Fetch-Site`, which a current browser sends to every secure origin, so on HTTPS another site
/// on the domain cannot plant one there; never with [`crate::security::Policy::hsts`], which says
/// the app is HTTPS only.
pub(crate) const PLAIN_NOTICE_COOKIE: &str = "corten-notice";
/// The longest notice kept, in bytes: a sentence, well inside a cookie's 4 KB once encoded.
const NOTICE_MAX: usize = 500;

/// Responses depend on the mode header and, for [`Mode::Data`], on `Accept`.
pub(crate) const VARY: &str = "corten, accept";
/// The same, for an answer whose locale follows `Accept-Language`.
pub(crate) const VARY_LANGUAGE: &str = "corten, accept, accept-language";

/// Settles the answer's dependency on `Accept-Language` as it leaves the app, whatever made it: a
/// page, JSON, a redirect, the error page, or a middleware that read messages after `next` or put
/// its own `Vary` on a kept page (which says the language it was kept for, [`crate::kept`]). When
/// something negotiated the request's locale from the header (`asked`, read from
/// [`crate::Signal::asked_language`] before the answer's body is wrapped) and no line of the
/// answer's `Vary` names it (or `*`), it is added ([`add_language`]). A page that read messages
/// before it was made names it on its own line ([`Req::vary`]), which is taken as it is, unscanned.
/// Returns whether the answer has a `Vary`, so the security headers do not look it up again.
///
/// Inlined, so the common answer (a page's own line, or nothing negotiated) costs the lookup the
/// security headers would make anyway and a comparison.
#[inline(always)]
pub(crate) fn vary_on_language(asked: bool, headers: &mut HeaderMap) -> bool {
    match headers.get(header::VARY) {
        None if !asked => false,
        Some(first) if !asked || first.as_bytes() == VARY_LANGUAGE.as_bytes() => true,
        _ => {
            name_language(headers);
            true
        }
    }
}

/// The rest of [`vary_on_language`]: `accept-language` added unless a line names it or `*`.
#[inline(never)]
fn name_language(headers: &mut HeaderMap) {
    let named = headers.get_all(header::VARY).iter().any(|line| {
        line.as_bytes()
            .split(|&b| b == b',')
            .map(<[u8]>::trim_ascii)
            .any(|name| name == b"*" || name.eq_ignore_ascii_case(b"accept-language"))
    });
    if !named {
        add_language(headers);
    }
}

/// Names `accept-language` in a `Vary` none of whose lines does: in the place of a page's own
/// line when it is the only one, as a page that read messages before it was made says it
/// ([`Req::vary`]), else on a line of its own beside the others.
pub(crate) fn add_language(headers: &mut HeaderMap) {
    let mut lines = headers.get_all(header::VARY).iter();
    let own = lines.next().is_some_and(|line| line.as_bytes() == VARY.as_bytes()) && lines.next().is_none();
    if own {
        headers.insert(header::VARY, HeaderValue::from_static(VARY_LANGUAGE));
    } else {
        headers.append(header::VARY, HeaderValue::from_static("accept-language"));
    }
}

/// How the client asked for this response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// A normal browser request: first load, reload, or any request without JavaScript; also the
    /// runtime's fetch of the page a write redirects to, whose layout it draws again (`corten:
    /// page`).
    Document,
    /// The runtime is navigating to a page and will swap it into `<main>`.
    Navigation,
    /// The runtime submitted a `<form data-patch>`: it applies a patch's fragments by id, follows a
    /// redirect, and draws a page. A write's own is whole, layout included, when the runtime
    /// prefers it (`Prefer: corten-draws=whole`); otherwise it draws a fragment, as for `GET` and `HEAD`.
    Action,
    /// A client that renders by itself (a native screen, an agent) asked for
    /// `Accept: application/json`. [`Req::screen`] answers with the page's data; [`Req::page`]
    /// still answers with the HTML document.
    Data,
}

impl Mode {
    /// The runtime keeps the page it has for this answer ([`Mode::Navigation`], [`Mode::Action`]):
    /// a navigation's page renders only its title, head tags and `<main>`, a `GET` form's too, and
    /// a patch replaces elements by id, so the layout around `<main>` (the header, a cart's count in
    /// it) stays as the full load drew it. What a write changed there is drawn by the two answers to
    /// a write that are pages: the page it redirects to, which the runtime fetches as a
    /// [`Mode::Document`], and its own page ([`Req::page`] for a method other than `GET` or `HEAD`),
    /// which is whole in document mode or an action with `Prefer: corten-draws=whole`.
    /// A value only the layout shows is a [`crate::LayoutRead`], which Corten
    /// starts for those answers and no others; code that reads such a value itself before the
    /// handler (an [`crate::Ahead`] in an extractor) skips it only for a swap that is no write:
    ///
    /// ```
    /// use corten::{http::{request::Parts, Method}, prelude::*};
    ///
    /// /// A conservative check: an action write may prefer to draw its own page whole.
    /// fn may_draw_the_layout(parts: &Parts) -> bool {
    ///     let mode = Mode::of(&parts.headers);
    ///     !mode.swaps() || (mode == Mode::Action && !matches!(parts.method, Method::GET | Method::HEAD))
    /// }
    /// # let _ = may_draw_the_layout;
    /// ```
    #[inline]
    pub const fn swaps(self) -> bool {
        matches!(self, Mode::Navigation | Mode::Action)
    }

    /// The mode a request's headers ask for, as [`Req::mode`] reads it: for code that runs before
    /// the handler has its `Req`, an extractor or a [`crate::Middleware`] that starts a read only
    /// a full load needs (see [`crate::Ahead`]). A handler reads `req.mode`.
    pub fn of(headers: &HeaderMap) -> Mode {
        Mode::asked(headers).0
    }

    /// The mode, and whether the runtime sent the request (`corten` is `nav`, `action` or
    /// `page`), in one lookup: a redirect to a place or another site is then named in
    /// `corten-location`, as `fetch` cannot follow one, and the answer is not shared (#1034).
    pub(crate) fn asked(headers: &HeaderMap) -> (Mode, bool) {
        Self::read(headers, false).0
    }

    /// The mode, and whether the runtime sent the request, from the two headers that say so:
    /// `corten`, and the first `Accept` line, which is asked for only where `corten` names no
    /// mode. With them, that `Accept` as text, empty where it was not asked for, not sent or not
    /// text. The rule is written here and nowhere else in the request's path: [`Mode::asked`]
    /// looks the two up and `crate::kept` gives them from its pass over a request's headers, so
    /// a header this function is made to read is an argument each of them has to give. A request
    /// under an API is the one the stages do not pass here: they ask nothing of its mode
    /// ([`RequestPage::read`]), and a handler's [`Req`] there still does. Browsers never put JSON
    /// first for a navigation.
    pub(crate) fn said<'a>(
        runtime: Option<&HeaderValue>,
        accept: impl FnOnce() -> Option<&'a HeaderValue>,
    ) -> ((Mode, bool), &'a str) {
        let runtime = match runtime.map(HeaderValue::as_bytes) {
            Some(b"nav") => Some(Mode::Navigation),
            Some(b"action") => Some(Mode::Action),
            Some(b"page") => Some(Mode::Document),
            _ => None,
        };
        if let Some(mode) = runtime {
            return ((mode, true), "");
        }
        let accept = accept().and_then(|accept| accept.to_str().ok()).unwrap_or("");
        // The first item's media type, without its parameters and the whitespace around it, is
        // JSON: the line starts with it after whitespace, and whitespace then ends the item or
        // starts its parameters. Read so, a line that starts otherwise is not looked at further.
        let json = accept.as_bytes().trim_ascii_start().split_at_checked(crate::api::JSON.len()).is_some_and(|(ty, rest)| {
            (ty == crate::api::JSON.as_bytes() || ty.eq_ignore_ascii_case(crate::api::JSON.as_bytes()))
                && matches!(rest.trim_ascii_start().first(), None | Some(b',' | b';'))
        });
        let mode = if json { Mode::Data } else { Mode::Document };
        ((mode, false), accept)
    }

    /// [`Mode::said`] of the request's two headers, and whether a document was asked for by an
    /// `Accept` that names HTML. Nothing of the mode is decided here: `crate::kept` decides
    /// whether a kept page can answer without this function.
    fn read(headers: &HeaderMap, check_html: bool) -> ((Mode, bool), bool) {
        let (asked, accept) = Mode::said(headers.get(MODE_HEADER), || headers.get(header::ACCEPT));
        // A browser's navigation names HTML first, so the start is looked at before the line is
        // searched: `str::contains` prepares a search made for long text before it looks.
        let html = || accept.starts_with("text/html") || accept.contains("text/html");
        (asked, check_html && asked.0 == Mode::Document && html())
    }
}

#[inline]
fn accept(headers: &HeaderMap) -> &str {
    headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// A write the runtime sent (`mode`, `method`) that answers its own page whole: one whose runtime
/// says it draws one ([`PREFER`]). Looked up only for such a write.
#[inline]
fn own_page_whole(mode: Mode, method: &http::Method, headers: &HeaderMap) -> bool {
    mode == Mode::Action && !matches!(*method, http::Method::GET | http::Method::HEAD) && prefers_whole(headers)
}

/// Whether the request prefers `corten-draws=whole` (RFC 7240, 2): its first `corten-draws`
/// preference across every `Prefer` line, named case aside, its value as written (a token, or a
/// quoted string without an escape), its parameters aside. Any other value, or none, is `<main>`,
/// which every runtime draws.
pub(crate) fn prefers_whole(headers: &HeaderMap) -> bool {
    for line in headers.get_all(PREFER) {
        // The line the runtime sends, read without taking it apart: nothing before it in the
        // request named `corten-draws`, and it names nothing else.
        if line.as_bytes() == DRAWS_WHOLE.as_bytes() {
            return true;
        }
        for preference in crate::cache::split_unquoted(line.as_bytes(), b',') {
            let named = crate::cache::split_unquoted(preference, b';').next().unwrap_or_default();
            let (name, value) = match named.iter().position(|&b| b == b'=') {
                Some(at) => (&named[..at], &named[at + 1..]),
                None => (named, &b""[..]),
            };
            if !name.trim_ascii().eq_ignore_ascii_case(b"corten-draws") {
                continue;
            }
            let value = value.trim_ascii();
            let value = value.strip_prefix(b"\"").and_then(|v| v.strip_suffix(b"\"")).unwrap_or(value);
            return value == b"whole";
        }
    }
    false
}

/// How long a hover prefetch may take before a debug build names its page.
#[cfg(debug_assertions)]
const SLOW_PREFETCH: std::time::Duration = std::time::Duration::from_millis(500);

/// In a debug build: a hover prefetch, which when it is dropped (answered, or given up on by the
/// runtime) logs a page that took longer than [`SLOW_PREFETCH`], naming the URL and how to keep
/// its work for a click. The answer is unchanged.
#[cfg(debug_assertions)]
pub(crate) struct Prefetched {
    pub began: std::time::Instant,
    uri: Uri,
    /// The page was drawn; otherwise the runtime gave up on it first.
    pub answered: bool,
}

#[cfg(debug_assertions)]
impl Prefetched {
    pub(crate) fn new(uri: &Uri) -> Self {
        Prefetched { began: std::time::Instant::now(), uri: uri.clone(), answered: false }
    }
}

#[cfg(debug_assertions)]
impl Drop for Prefetched {
    fn drop(&mut self) {
        slow_prefetch(&self.uri, self.began.elapsed(), self.answered);
    }
}

#[cfg(debug_assertions)]
fn slow_prefetch(uri: &Uri, took: std::time::Duration, answered: bool) {
    if took < SLOW_PREFETCH {
        return;
    }
    let what = if answered {
        "drew the page ahead of a click, which took"
    } else {
        "started the page ahead of a click, given up on after"
    };
    tracing::warn!(
        "corten: hovering a link to {uri} {what} {} ms: a route costly for every URL says #[route(\"..\", prefetch = false)], and one costly for some names a function of the route that says which, prefetch = cheap",
        took.as_millis()
    );
}

/// The runtime's hover prefetch, which says `purpose: prefetch` (a script may not send
/// `Sec-Purpose`).
#[cfg(debug_assertions)]
pub(crate) fn is_prefetch(headers: &HeaderMap) -> bool {
    headers.get("purpose").is_some_and(|v| v.as_bytes() == b"prefetch")
}

/// Whether a nav link to `href` holds the page at `path`, by the runtime's rule (`markCurrent` in
/// `corten.js`): never for a URL that is not a path on this site ([`is_path`]).
fn is_current(path: &str, href: &str, section: bool) -> bool {
    let href = href.split(['?', '#']).next().unwrap_or(href);
    // The check after the comparison, which rules out most links before it.
    (path == href || (section && path.strip_prefix(href.trim_end_matches('/')).is_some_and(|rest| rest.starts_with('/'))))
        && is_path(href)
}

/// Whether a nav link's URL, as written, is a path on this site, the only kind a nav compares with
/// the page: one `/` first, then neither `/` nor `\` (`//host/x` and `/\host/x` name another
/// host) nor a tab or line break, a syntax restriction kept for safety: a browser drops one, so
/// `/<tab>x` is this site's `/x` and `/<tab>/host/x` another host's. Anything else (a full URL, a
/// relative one, `?tab=2`, one that starts with a space) is never current, on the server and in the
/// runtime (`isPath` in `corten.js`), which tests the same text, the `href` the server wrote. The
/// start of [`crate::Local::parse`]'s rule, without its refusal of a character the URL Standard
/// keeps in a path or encodes, which only changes the path a nav compares.
#[inline(always)]
fn is_path(href: &str) -> bool {
    let bytes = href.as_bytes();
    bytes.first() == Some(&b'/') && !matches!(bytes.get(1), Some(b'/' | b'\\' | b'\t' | b'\n' | b'\r'))
}

/// A nav link's attributes, from [`Req::nav`] or [`Req::nav_section`]: `href`, `data-nav` and,
/// on its own page, `aria-current="page"`. The route's URL is made once, written and compared.
pub struct Nav<'a, R> {
    pub(crate) path: &'a str,
    pub(crate) to: &'a R,
    pub(crate) section: bool,
}

impl<R> crate::view::__private::Writes for Nav<'_, R> {
    type Static = Nav<'static, ()>;
    const WRITES: &'static [&'static str] = &["href", "data-nav", "aria-current", "data-no-prefetch"];
}

impl<R: crate::Route> crate::view::Attrs for Nav<'_, R> {
    fn render_attrs(&self, out: &mut String) {
        let start = out.len() + r#" href=""#.len();
        out.push_str(r#" href=""#);
        crate::Route::write_href(self.to, out, true);
        // A derived route's path holds no character escaping changes, and the comparison stops
        // before the query, so the written text is compared. A hand-written route whose path was
        // escaped is compared as its unescaped URL.
        let written = &out[start..];
        let current = if written.split(['?', '#']).next().unwrap_or(written).contains('&') {
            is_current(self.path, &crate::route::link(self.to), self.section)
        } else {
            is_current(self.path, written, self.section)
        };
        out.push('"');
        out.push_str(if self.section { r#" data-nav="section""# } else { " data-nav" });
        if current {
            out.push_str(r#" aria-current="page""#);
        }
        crate::route::no_prefetch(" href", self.to.may_prefetch(), out);
    }
}

/// What a nav entry can link to: a typed route, or a [`crate::Local`] path read from data. Not a
/// URL written as text, nor another site's (`Elsewhere`, a `Uri`): that is never this page. A route
/// is trusted as [`Req::redirect`] trusts it: one implemented by hand writes what it writes.
pub trait NavTarget: nav_target::Sealed {
    /// Writes the URL as the browser asks for it, not escaped for HTML.
    #[doc(hidden)]
    fn write_url(&self, out: &mut String);

    /// Whether the runtime may fetch the URL ahead of a click: a route's [`crate::Route::may_prefetch`].
    #[doc(hidden)]
    fn prefetch(&self) -> bool {
        true
    }
}

mod nav_target {
    pub trait Sealed {}
    impl<R: crate::Route + ?Sized> Sealed for R {}
    impl Sealed for crate::Local {}
}

impl<R: crate::Route + ?Sized> NavTarget for R {
    fn write_url(&self, out: &mut String) {
        self.write_href(out, false);
    }

    fn prefetch(&self) -> bool {
        self.may_prefetch()
    }
}

impl NavTarget for crate::Local {
    /// The path with the characters a browser percent-encodes in one (`` "<>`{}^| ``) encoded, so the
    /// link, the request it makes and the runtime's `pathname` are the same text in every engine
    /// (Firefox and WebKit keep `|`, Chromium encodes it).
    fn write_url(&self, out: &mut String) {
        let href = self.as_str();
        {
            let end = href.find(['?', '#']).unwrap_or(href.len());
            for c in href[..end].chars() {
                match c {
                    '"' | '<' | '>' | '`' | '{' | '}' | '^' | '|' => {
                        const HEX: &[u8; 16] = b"0123456789ABCDEF";
                        out.push('%');
                        out.push(HEX[c as usize >> 4] as char);
                        out.push(HEX[c as usize & 15] as char);
                    }
                    c => out.push(c),
                }
            }
            out.push_str(&href[end..]);
        }
    }
}

/// Writes the comparison key of `url`, a URL on this site: its path as the browser's
/// `location.pathname` shows it at that URL, by the URL Standard's parser
/// (<https://url.spec.whatwg.org/#concept-basic-url-parser>) for a path that starts with `/`:
/// leading and trailing spaces and control characters trimmed, every tab and line break dropped,
/// the query and fragment left out, `\` read as `/`, the `.` and `..` segments resolved (`%2e` for a
/// dot too, in either case), and a control character, a space, `` "<>^`{} `` and each byte of a
/// character beyond ASCII percent-encoded. Then the spellings engines differ on are made one
/// ([`keyed`]): `|` is encoded, and each escape's hex digits are uppercased. [`key`] makes the page's
/// path the same key before comparing. The result has no space in it.
fn pathname(url: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let from = out.len();
    let url = url.trim_matches(|c: char| c <= ' ');
    let path = url.split(['?', '#']).next().unwrap_or("");
    let path = path.strip_prefix(['/', '\\']).unwrap_or(path);
    let mut chars = path.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r'));
    // Where each segment kept so far starts in `out`, at its `/`.
    let mut kept: Vec<usize> = Vec::new();
    loop {
        let start = out.len();
        out.push('/');
        let mut end = true;
        for c in chars.by_ref() {
            match c {
                '/' | '\\' => {
                    end = false;
                    break;
                }
                '\0'..=' ' | '"' | '<' | '>' | '^' | '`' | '{' | '}' | '|' | '\x7f'.. => {
                    for byte in c.encode_utf8(&mut [0; 4]).bytes() {
                        out.push('%');
                        out.push(HEX[byte as usize >> 4] as char);
                        out.push(HEX[byte as usize & 15] as char);
                    }
                }
                c => out.push(c),
            }
        }
        let segment = &out[start + 1..];
        let is = |forms: &[&str]| forms.iter().any(|form| segment.eq_ignore_ascii_case(form));
        let double = is(&["..", ".%2e", "%2e.", "%2e%2e"]);
        if double || is(&[".", "%2e"]) {
            out.truncate(start);
            if double {
                if let Some(previous) = kept.pop() {
                    out.truncate(previous);
                }
            }
            // A `.` or `..` that ends the path leaves it ending in `/`.
            if end {
                kept.push(out.len());
                out.push('/');
            }
        } else {
            kept.push(start);
        }
        if end {
            break;
        }
    }
    let written = out.split_off(from);
    keyed(&written, out);
}

/// Writes `text`, a path, as a comparison key to `out`: each `|` as `%7C`, Chromium's spelling,
/// where Firefox and WebKit keep `|` in a request and in `location.pathname`, and the two hex digits
/// of each percent escape uppercase, as WebKit asks for `%7c` as `%7C` while its
/// `location.pathname` keeps `%7c`. Nothing is decoded, and a `%` without two hex digits after it
/// is kept as it is, so the server's key of a request and the runtime's of `location.pathname` are
/// the same text whenever the two are. A path with an escaped unreserved character is not one
/// Corten writes ([`crate::route::escapes_unreserved`]); one typed by hand is compared as written.
fn keyed(text: &str, out: &mut String) {
    let bytes = text.as_bytes();
    let hex = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_hexdigit);
    let (mut kept, mut i) = (0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b'|' => {
                out.push_str(&text[kept..i]);
                out.push_str("%7C");
                i += 1;
            }
            b'%' if hex(i + 1) && hex(i + 2) => {
                // `%` and the hex digits are ASCII, so these are whole characters.
                out.push_str(&text[kept..i + 1]);
                out.push(bytes[i + 1].to_ascii_uppercase() as char);
                out.push(bytes[i + 2].to_ascii_uppercase() as char);
                i += 3;
            }
            _ => {
                i += 1;
                continue;
            }
        }
        kept = i;
    }
    out.push_str(&text[kept..]);
}

/// One entry of a nav, for [`Req::nav_of`].
pub struct NavTo<'a> {
    to: &'a dyn NavTarget,
    section: bool,
    /// Other addresses that serve the entry's page ([`NavTo::also`]), boxed so an entry without
    /// them is one word larger than before they existed.
    // Boxed, not a `Vec` in place: an eight-entry nav without aliases measured about 60 instructions
    // a request more with the `Vec`.
    also: Option<Box<Others<'a>>>,
}

/// An entry's other addresses ([`NavTo::also`]): the first in the box, so an entry with one costs
/// one allocation, and any more after it.
struct Others<'a> {
    first: &'a dyn NavTarget,
    rest: Vec<&'a dyn NavTarget>,
}

impl<'a> NavTo<'a> {
    /// An entry current on its own URL alone (the query and fragment aside), as [`Req::nav`].
    pub fn page(to: &'a (impl NavTarget + 'a)) -> Self {
        NavTo { to, section: false, also: None }
    }

    /// An entry current on its own URL and every one under it, as [`Req::nav_section`]: a
    /// deeper entry of the same nav that also holds the page wins over it.
    pub fn section(to: &'a (impl NavTarget + 'a)) -> Self {
        NavTo { to, section: true, also: None }
    }

    /// The entry is current at `other` too, another address that serves its page (an older one
    /// that stored links still carry), by the same rule as at its own URL. Where several of its
    /// addresses hold the page, the deepest of them is the entry's depth, so an `other` deeper than
    /// the entry's URL wins over an entry whose URL is between the two. The link still goes to its
    /// own URL. `other`'s path is written in `data-nav-also` once, as a
    /// comparison key: the path the browser's `location.pathname` shows at that address
    /// (`/old/./a/../b ` as `/old/b`, `/old/café` as `/old/caf%C3%A9`), with the two spellings
    /// engines differ on made one, a `|` as `%7C` (which Chromium shows and Firefox and WebKit do
    /// not) and an escape's hex digits uppercase (`%7c` as `%7C`, which WebKit asks for while its
    /// `location.pathname` keeps `%7c`); no escape is decoded. In a nav with other addresses every
    /// entry's own URL is compared by its key too. The server compares the keys with the request
    /// path's and the runtime with `location.pathname`'s, each made the same way and compared as
    /// plain text, so for every address Corten writes they mark the same link at first render and
    /// after a client navigation in Chromium, Firefox and WebKit.
    ///
    /// An address whose path, once its `.` and `..` segments are resolved, has a percent escape of
    /// a letter, a digit, `-`, `.`, `_` or `~` (`/old/%41`, `/old/%2e%2ex`) is left out, on the
    /// server and so in the runtime: WebKit asks for it decoded while its `location.pathname` keeps
    /// the escape, so the two would mark different links. A dot segment written escaped is resolved
    /// first, as every engine does, so `/old/%2e%2e/x` is `/x` and kept. A typed route never writes
    /// such an escape and a [`crate::Local`] cannot hold one; only a route
    /// implemented by hand can. A path with such an escape typed by hand is compared as written, so
    /// it is never the address with the plain character. That is one limit, in any nav: WebKit asks
    /// for `/%73ettings` as `/settings`, so its first render marks the entry at `/settings` and its
    /// runtime, at the same address, does not; Chromium and Firefox ask for it as written and
    /// neither marks it. The other is a nav without other addresses, which compares the paths as
    /// written: an entry at `/old%7chome` is unmarked in WebKit's first render, which asks for
    /// `/old%7Chome`, and marked by its runtime, whose `location.pathname` keeps `%7c`, as an entry
    /// at `/a|b` is in Chromium, which asks for and shows `/a%7Cb`.
    ///
    /// An address that is not a path on this site, `//host/old` or `/\host/old`, names another
    /// host, so it is left out, as the runtime would read its pathname as that host's; and an entry
    /// whose own URL is one is never current, at any of its addresses ([`Req::nav_of`]). A tab or
    /// line break straight after the first `/` is refused the same way, a syntax restriction kept
    /// for safety rather than a browser's rule: a browser drops it, so `/<tab>old` is this site's
    /// `/old`, and it names another host only when a `/` or `\` follows (`/<tab>/host/old`). Only a
    /// route implemented by hand can write one.
    ///
    /// A NUL in the entry's own URL, which only a route implemented by hand writes, is read by the
    /// HTML parser as U+FFFD in the `href` the runtime parses, so the link to `/old<NUL>x` goes to
    /// `/old%EF%BF%BDx`, where the entry is ranked, not `/old%00x`. An other address is not an
    /// `href`, and one holding a raw NUL is not a usable address: Chromium and WebKit ask for
    /// `/old%00x` and Firefox cuts it at the NUL and asks for `/old`, so it is left out and the
    /// entry is never current by it, as for an address that is not a path on this site. An app that
    /// means that address writes the escape, `/old%00x`, which is kept.
    ///
    /// A typed route or a [`crate::Local`], as the entry's own:
    ///
    /// ```
    /// use corten::prelude::*;
    /// use corten::NavTo;
    ///
    /// #[derive(Route)]
    /// #[route("/settings")]
    /// struct Settings;
    /// #[derive(Route)]
    /// #[route("/governance")]
    /// struct Governance;
    ///
    /// // On /governance: <a href="/settings" data-nav data-nav-group=".." data-nav-also="/governance" aria-current="page">
    /// fn nav(req: &Req) -> String {
    ///     let nav = req.nav_of([(NavTo::page(&Settings).also(&Governance), "Settings")]);
    ///     html! { <nav>for (link, label) in nav.links() { <a {..link}>{*label}</a> }</nav> }.to_html()
    /// }
    /// let _: fn(&Req) -> String = nav;
    /// ```
    ///
    /// A URL written as text is not one:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[derive(Route)]
    /// #[route("/settings")]
    /// struct Settings;
    /// let _ = corten::NavTo::page(&Settings).also(&"/governance");
    /// ```
    ///
    /// Nor can a tag write `data-nav-also` as an attribute of its own, in any case, which the server
    /// did not rank (a spread of attribute pairs still passes it through, as it does `data-nav`):
    ///
    /// ```compile_fail
    /// use corten::prelude::*;
    ///
    /// let link = html! { <a data-nav-also="/governance">"Settings"</a> };
    /// ```
    ///
    /// ```compile_fail
    /// use corten::prelude::*;
    ///
    /// let link = html! { <a data-Nav-Also="/governance">"Settings"</a> };
    /// ```
    pub fn also(mut self, other: &'a (impl NavTarget + 'a)) -> Self {
        match &mut self.also {
            Some(others) => others.rest.push(other),
            None => self.also = Some(Box::new(Others { first: other, rest: Vec::new() })),
        }
        self
    }
}

/// A nav's links, from [`Req::nav_of`], each with its item, with the deepest entries that hold
/// the page marked current. Each URL is written once, at the call.
pub struct NavLinks<T> {
    /// The URLs one after another, not escaped.
    urls: String,
    /// Where each entry's URL ends, whether it is a section, how deep it is when it holds the
    /// page, its item, and whether the runtime may prefetch it.
    entries: Vec<(usize, bool, Option<usize>, T, bool)>,
    /// The deepest of them: the entries that deep are current.
    deepest: Option<usize>,
    /// The group the runtime ranks these links in (`data-nav-group`): 32 bits of a hash of the
    /// entries, so a patch's nav does not join another of the page's, and two equal navs agree
    /// anyway. Navs made to collide only mark the wrong link after a navigation. A nav with other
    /// addresses writes its group, followed by a `+`, from [`Also`] ([`Also::write_text`]).
    group: [u8; 8],
    /// The entries' other addresses ([`NavTo::also`]), when one has some; none, and the nav is drawn
    /// as it was before they existed.
    also: Option<Box<Also>>,
}

/// The other addresses of a nav's entries ([`NavTo::also`]).
struct Also {
    /// Their paths ([`pathname`]), one entry's after another, separated by spaces within an entry,
    /// not escaped; then, from `text` on, what each link writes as its `data-nav-group` value
    /// ([`Also::write_text`]).
    paths: String,
    /// Each entry that has some, in the nav's order: where its URL ends in [`NavLinks`]'s `urls`,
    /// which names the entry, where its paths end, and where its `data-nav-group` value ends.
    ends: Vec<(usize, usize, usize)>,
    /// Where the `data-nav-group` values start in `paths`.
    text: usize,
}

impl Also {
    /// Writes after the paths, escaped, what each link writes as its `data-nav-group` value: first
    /// the group and its `+`, for a link without other addresses, then for each entry of `ends` the
    /// group, its `+`, the quote that closes the attribute, and ` data-nav-also="` with the entry's
    /// paths, which the link's own closing quote ends. So a link carries its other addresses in the
    /// text it already writes, and is no larger than a link of a nav without them; and the text
    /// shares the paths' allocation.
    #[cold]
    #[inline(never)]
    fn write_text(&mut self, group: &[u8; 8]) {
        let group = std::str::from_utf8(group).expect("hex digits");
        let Also { paths, ends, text } = self;
        *text = paths.len();
        paths.push_str(group);
        paths.push('+');
        let mut start = 0;
        for (_, end, written) in ends.iter_mut() {
            paths.push_str(group);
            paths.push_str(r#"+" data-nav-also=""#);
            if crate::ascii::any(&paths.as_bytes()[start..*end], crate::ascii::html) {
                crate::view::escape_from_within(paths, start..*end);
            } else {
                paths.extend_from_within(start..*end);
            }
            *written = paths.len();
            start = *end;
        }
    }

    /// The `data-nav-group` value of the link whose URL is `url` and ends at `url_end`: its
    /// entry's, when it has other addresses, else the plain group's. Only an entry whose URL is a
    /// path on this site has some ([`other_addresses`]), and such a URL, never empty, ends where no
    /// other entry's does but an empty URL straight after it, which has none. Out of line and
    /// reached only from a nav that has some, so a link of a nav without them looks nothing up.
    #[cold]
    #[inline(never)]
    fn group(&self, url: &str, url_end: usize) -> &str {
        let plain = self.text..self.text + 9;
        match self.ends.binary_search_by_key(&url_end, |&(of, ..)| of) {
            Ok(i) if !url.is_empty() => {
                let start = if i == 0 { plain.end } else { self.ends[i - 1].2 };
                &self.paths[start..self.ends[i].2]
            }
            _ => &self.paths[plain],
        }
    }
}

impl<T> NavLinks<T> {
    /// Each link's attributes with its item, in the entries' order:
    /// `for (link, item) in nav.links() { <a {..link}>{&item.label}</a> }`. Render every one: the
    /// runtime ranks the links in the page, the server ranked them all.
    pub fn links(&self) -> impl Iterator<Item = (NavLink<'_>, &T)> {
        let mut start = 0;
        let plain = std::str::from_utf8(&self.group).expect("hex digits");
        let also = self.also.as_deref();
        self.entries.iter().map(move |(end, section, depth, item, prefetch)| {
            let url = &self.urls[start..*end];
            start = *end;
            let group = match also {
                None => plain,
                Some(also) => also.group(url, *end),
            };
            (
                NavLink {
                    url,
                    section: *section,
                    current: depth.is_some() && *depth == self.deepest,
                    group,
                    prefetch: *prefetch,
                },
                item,
            )
        })
    }
}

/// One link of a [`NavLinks`]: `href`, `data-nav`, `data-nav-group`, for an entry with other
/// addresses `data-nav-also` ([`NavTo::also`]), when current `aria-current="page"`, and
/// `data-no-prefetch` for a URL its route says a hover may not fetch ([`crate::Route::may_prefetch`]).
pub struct NavLink<'a> {
    url: &'a str,
    section: bool,
    current: bool,
    /// The group, and for a link with other addresses its `data-nav-also` after it
    /// ([`Also::write_text`]).
    group: &'a str,
    prefetch: bool,
}

impl NavLink<'_> {
    /// Whether this link writes `aria-current="page"` for this request.
    pub fn is_current(&self) -> bool {
        self.current
    }
}

impl crate::view::__private::Writes for NavLink<'_> {
    type Static = NavLink<'static>;
    const WRITES: &'static [&'static str] =
        &["href", "data-nav", "data-nav-group", "data-nav-also", "aria-current", "data-no-prefetch"];
}

impl crate::view::Attrs for NavLink<'_> {
    fn render_attrs(&self, out: &mut String) {
        out.push_str(r#" href=""#);
        crate::view::escape_into(self.url, out);
        out.push('"');
        out.push_str(if self.section { r#" data-nav="section""# } else { " data-nav" });
        out.push_str(r#" data-nav-group=""#);
        out.push_str(self.group);
        out.push('"');
        if self.current {
            out.push_str(r#" aria-current="page""#);
        }
        crate::route::no_prefetch(" href", self.prefetch, out);
    }
}

/// How deep an entry is, by its path without the query, fragment or trailing `/`, when it holds
/// `path`; the runtime's rule for the links of one `data-nav-group` (`markCurrent` in `corten.js`).
fn holds(path: &str, url: &str, section: bool) -> Option<usize> {
    is_current(path, url, section).then(|| url.split(['?', '#']).next().unwrap_or(url).trim_end_matches('/').len())
}

/// [`holds`] for `href`, a path without a query or fragment, such as a comparison key, which it
/// need not look for.
fn holds_path(path: &str, href: &str, section: bool) -> Option<usize> {
    let held =
        path == href || (section && path.strip_prefix(href.trim_end_matches('/')).is_some_and(|rest| rest.starts_with('/')));
    held.then(|| href.trim_end_matches('/').len())
}

/// Where the path of `url`, a URL on this site, ends when that path is its own comparison key
/// ([`pathname`]), so the key need not be written: it starts with `/`, every character of it is one
/// the URL Standard keeps in a path as it is and [`keyed`] does not rewrite (a letter, a digit,
/// `/` or one of `` -._~!$&'()*+,;=:@ ``: no `%`, `|`, `\`, space or control character), and it has
/// no `.` or `..` segment. Every typed route's URL without an escape is one.
fn own_key(url: &str) -> Option<usize> {
    // What each byte is in such a path: 1 a character kept as written, 2 `/`, 3 the `?` or `#`
    // that ends it, 0 anything else. A table, so a byte costs one lookup.
    const CLASS: [u8; 256] = {
        let kept = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@";
        let mut class = [0; 256];
        let mut i = 0;
        while i < kept.len() {
            class[kept[i] as usize] = 1;
            i += 1;
        }
        class[b'/' as usize] = 2;
        class[b'?' as usize] = 3;
        class[b'#' as usize] = 3;
        class
    };
    let dots = |segment: &[u8]| matches!(segment, b"." | b"..");
    let bytes = url.as_bytes();
    if bytes.first() != Some(&b'/') {
        return None;
    }
    // Where the segment being read starts.
    let (mut segment, mut i) = (1, 1);
    while i < bytes.len() {
        match CLASS[bytes[i] as usize] {
            1 => {}
            2 if dots(&bytes[segment..i]) => return None,
            2 => segment = i + 1,
            3 => return (!dots(&bytes[segment..i])).then_some(i),
            _ => return None,
        }
        i += 1;
    }
    (!dots(&bytes[segment..])).then_some(bytes.len())
}

#[cfg(test)]
pub(crate) fn own_key_for_tests(url: &str) -> (Option<usize>, String) {
    let mut key = String::new();
    pathname(url, &mut key);
    (own_key(url), key)
}

/// Writes the other addresses ([`NavTo::also`]) of the entry whose URL ends at `url_end` to
/// `also`, separated by spaces, each as its comparison key ([`pathname`]), and leaves out one whose
/// key, its `.` and `..` segments resolved, has an escaped unreserved character
/// ([`crate::route::escapes_unreserved`]), which WebKit asks for in another spelling than its
/// `location.pathname` shows, one that is not a path on this site ([`is_path`]), which is never
/// compared, and one holding a raw NUL, which engines ask for at different addresses. An entry left
/// with none is written as one without them. Each URL is written straight into the paths, and one
/// that is its own key ([`own_key`]) is kept as written. Out of line, so a nav without them is drawn
/// as it was before they existed.
#[cold]
#[inline(never)]
fn other_addresses(others: &Others<'_>, url_end: usize, also: &mut Option<Box<Also>>) {
    let had = also.is_some();
    let held =
        also.get_or_insert_with(|| Box::new(Also { paths: String::with_capacity(128), ends: Vec::with_capacity(4), text: 0 }));
    let paths = &mut held.paths;
    let from = paths.len();
    for other in std::iter::once(others.first).chain(others.rest.iter().copied()) {
        let start = paths.len();
        if start > from {
            paths.push(' ');
        }
        let at = paths.len();
        other.write_url(paths);
        // Not a path on this site (`//host/old`): never compared, so not written.
        if !is_path(&paths[at..]) {
            paths.truncate(start);
            continue;
        }
        match own_key(&paths[at..]) {
            // A raw NUL anywhere (in the query or fragment of an address that is its own key,
            // which refuses one in its path): not a usable address. Firefox cuts the URL there and
            // asks for what comes before it where Chromium and WebKit ask for `%00`, so no key holds
            // it in every engine; an app that means `%00` writes it so.
            Some(len) if paths[at + len..].contains('\0') => paths.truncate(start),
            Some(len) => paths.truncate(at + len),
            None if paths[at..].contains('\0') => paths.truncate(start),
            None => {
                let url = paths.split_off(at);
                pathname(&url, paths);
                if crate::route::escapes_unreserved(&paths[at..]) {
                    paths.truncate(start);
                }
            }
        }
    }
    let end = paths.len();
    if end > from {
        held.ends.push((url_end, end, 0));
    } else if !had {
        *also = None;
    }
}

/// The comparison key of the page's path ([`keyed`]), which the runtime makes of
/// `location.pathname` the same way.
fn key(path: &str) -> std::borrow::Cow<'_, str> {
    if !path.bytes().any(|b| b == b'|' || b == b'%') {
        return path.into();
    }
    let mut key = String::with_capacity(path.len());
    keyed(path, &mut key);
    key.into()
}

/// Ranks every entry of a nav with other addresses ([`NavTo::also`]) by comparison keys: the page's
/// path's ([`key`]) with each entry's own URL's and each of its other addresses' ([`pathname`]), as
/// the runtime does in a group named with a trailing `+`, so the server and the runtime mark the
/// same entry whether an engine asks for and shows a `|` or an escape's hex digits in one case or
/// another. An entry whose URL is its own key ([`own_key`]) on a page whose path is its own keeps
/// the depth it was ranked with as written, which is the same; one whose URL is not a path on this
/// site ([`is_path`]) holds no page and has no other addresses. An entry's own URL is keyed as the
/// runtime reads it from the `href` the server wrote, where the HTML parser has made each NUL
/// U+FFFD, so the link goes to `/a%EF%BF%BD` rather than `/a%00`. Out of line, so a nav without
/// them is ranked as it was before they existed, by the request path as written.
#[cold]
#[inline(never)]
fn rank_by_keys<T>(path: &str, urls: &str, entries: &mut [(usize, bool, Option<usize>, T, bool)], also: &Also) {
    let page = key(path);
    let as_written = matches!(page, std::borrow::Cow::Borrowed(_));
    let (mut start, mut from, mut own) = (0, 0, String::new());
    let mut ends = also.ends.iter();
    let mut next = ends.next();
    for entry in entries {
        let url = &urls[start..entry.0];
        start = entry.0;
        let mut depth = match own_key(url) {
            _ if !is_path(url) => None,
            Some(_) if as_written => entry.2,
            Some(end) => holds_path(&page, &url[..end], entry.1),
            None => {
                own.clear();
                // `own_key` refuses a NUL, so only a URL keyed here can hold one.
                if url.contains('\0') {
                    pathname(&url.replace('\0', "\u{FFFD}"), &mut own);
                } else {
                    pathname(url, &mut own);
                }
                holds_path(&page, &own, entry.1)
            }
        };
        if let Some(&(_, end, _)) = next.filter(|&&(url_end, ..)| url_end == entry.0) {
            for other in also.paths[from..end].split(' ') {
                depth = depth.max(holds_path(&page, other, entry.1));
            }
            from = end;
            next = ends.next();
        }
        entry.2 = depth;
    }
}

/// [`Req::nav_of`] at `path`.
pub(crate) fn nav_links<'a, T>(path: &str, entries: impl IntoIterator<Item = (NavTo<'a>, T)>) -> NavLinks<T> {
    let (mut urls, mut also) = (String::new(), None);
    let mut entries: Vec<_> = entries
        .into_iter()
        .map(|(entry, item)| {
            let start = urls.len();
            entry.to.write_url(&mut urls);
            // An entry whose URL leads off this site is never current, at another address either.
            if let Some(others) = entry.also.as_deref().filter(|_| is_path(&urls[start..])) {
                other_addresses(others, urls.len(), &mut also);
            }
            (urls.len(), entry.section, holds(path, &urls[start..], entry.section), item, entry.to.prefetch())
        })
        .collect();
    if let Some(also) = &also {
        rank_by_keys(path, &urls, &mut entries, also);
    }
    let deepest = entries.iter().filter_map(|entry| entry.2).max();
    // The URLs, which are sections and any other addresses name the group; its 32 low bits, as
    // hex. A nav with no other addresses hashes as it did before they existed, with the low 16 bits
    // of where each URL ends. One with them hashes where each URL ends in full, which entry each
    // other address belongs to (where its URL ends) and where its paths end, so no two layouts of
    // the same text share a group: the runtime would clear the mark of one of them.
    let text = crate::fnv::extend(crate::fnv::OFFSET, urls.as_bytes());
    let hash = match &also {
        None => entries
            .iter()
            .fold(text, |hash, entry| crate::fnv::extend(hash, &[entry.1 as u8, (entry.0 >> 8) as u8, entry.0 as u8])),
        Some(also) => {
            let hash = entries.iter().fold(text, |hash, entry| {
                crate::fnv::extend(crate::fnv::extend(hash, &[entry.1 as u8]), &(entry.0 as u64).to_le_bytes())
            });
            also.ends.iter().fold(crate::fnv::extend(hash, also.paths.as_bytes()), |hash, &(url_end, end, _)| {
                crate::fnv::extend(crate::fnv::extend(hash, &(url_end as u64).to_le_bytes()), &(end as u64).to_le_bytes())
            })
        }
    };
    let mut group = [0; 8];
    for (i, digit) in group.iter_mut().enumerate() {
        *digit = b"0123456789abcdef"[(hash >> (28 - 4 * i) & 15) as usize];
    }
    if let Some(also) = &mut also {
        also.write_text(&group);
    }
    NavLinks { urls, entries, deepest, group, also }
}

#[cfg(test)]
pub(crate) fn is_current_for_tests(path: &str, href: &str, section: bool) -> bool {
    is_current(path, href, section)
}

/// Every way a request can fail, given to the app's error page ([`crate::App::error_page`]) for a
/// browser. A JSON route's failures, and a data client's, are JSON instead. A page that matches
/// each variant without `_` does not compile when Corten adds one, so it cannot miss it.
#[derive(Clone, Debug)]
pub enum Failure {
    /// Nothing is at this URL (404): no route has it, or its handler returned
    /// `Error::not_found()` (the error is logged).
    NotFound,
    /// A route has this URL but not this method, which the app implements: another route has a
    /// handler for it, a route takes every method (`any`, a relay), or it is `GET`, `HEAD` or
    /// `OPTIONS` (405; the `Allow` header is kept). One no route has is
    /// [`Failure::UnknownMethod`].
    WrongMethod,
    /// A route has this URL, and no route in the app has a handler for this method (`PROPFIND`,
    /// `QUERY`, or `PUT` in an app that routes none), nor takes every method (`any`): the router's
    /// 501, with no `Allow` (RFC 9110 9.1). Only the router's is this, and only while its body is
    /// still empty with a size known to be zero and a middleware has not turned it into another
    /// status. A middleware's body that is not plain text is kept as written; a plain-text one is
    /// [`Failure::Rejected`] with status 501, as a handler's plain-text `501` is; an empty body
    /// of unknown size (a wrapping or streaming middleware) is sent as a bare 501 with no error
    /// page. A `501` a handler or a middleware answers (`Error::status(NOT_IMPLEMENTED)`, or the
    /// bare status) is [`Failure::Failed`].
    UnknownMethod,
    /// A write another site sent (403), refused before anything else ran.
    CrossSite,
    /// The handler needs a [`crate::Caller`] the request does not have, or one who may not do
    /// this, and there is nowhere to sign in: 401 or 403, or 429 for a client with too many failed
    /// attempts ([`crate::Refused`]); or a middleware turned the request away with a `Refused`
    /// (a rate limit's 429), or the handler did (`Err(Refused::forbidden())?`).
    Refused { status: StatusCode },
    /// Who is asking could not be found out now ([`crate::Refused::unavailable`]: the session
    /// store is down), so the request was neither let through nor sent to sign in (503), by an
    /// extractor or by a handler's `Err(Refused::unavailable(..))?`. Not a handler's
    /// `Error::status(SERVICE_UNAVAILABLE)`, which is [`Failure::Failed`]. The detail is the
    /// lookup's error.
    Unidentified { detail: Option<Arc<str>> },
    /// The path, the query or the body did not parse (400, 415 or 422). The detail is the
    /// extractor's text, written for a developer.
    Rejected { status: StatusCode, detail: Option<Arc<str>> },
    /// The handler returned an [`Error`]: 500, or the status [`Error::status`] gave (a 404 is
    /// [`Failure::NotFound`]). Also the deadline that passed while the handler waited for the
    /// client to send the rest of the body (408), as a stalled upload's `?` gives, since the
    /// request did not arrive in time.
    Failed { status: StatusCode, detail: Option<Arc<str>> },
    /// The handler panicked (500).
    Panicked { detail: Option<Arc<str>> },
    /// The handler ran past the deadline ([`crate::App::deadline`], 503), not while it waited
    /// for the client's body (that is [`Failure::Failed`] with 408).
    TimedOut,
    /// The PWA's offline page, which the service worker shows when the network is down (sent
    /// with 200 so the worker keeps it).
    Offline,
}

impl Failure {
    /// The status the error page is sent with (the offline page's is 200).
    pub fn status(&self) -> StatusCode {
        match self {
            Failure::NotFound => StatusCode::NOT_FOUND,
            Failure::WrongMethod => StatusCode::METHOD_NOT_ALLOWED,
            Failure::UnknownMethod => StatusCode::NOT_IMPLEMENTED,
            Failure::CrossSite => StatusCode::FORBIDDEN,
            Failure::Refused { status } | Failure::Rejected { status, .. } | Failure::Failed { status, .. } => *status,
            Failure::Panicked { .. } => StatusCode::INTERNAL_SERVER_ERROR,
            Failure::TimedOut | Failure::Unidentified { .. } => StatusCode::SERVICE_UNAVAILABLE,
            Failure::Offline => StatusCode::OK,
        }
    }

    /// The default error page's English title and message, without any developer detail.
    /// Use this wording in an app's own layout.
    ///
    /// ```
    /// use corten::{Failure, http::StatusCode};
    ///
    /// let failure = Failure::Refused { status: StatusCode::TOO_MANY_REQUESTS };
    /// assert_eq!(failure.default_text(), ("Too many requests", "Wait a moment and try again."));
    /// ```
    pub fn default_text(&self) -> (&'static str, &'static str) {
        match self {
            Failure::NotFound => ("Not found", "There is nothing at this address."),
            Failure::CrossSite => ("Not allowed", "This request came from another site."),
            Failure::Refused { status } if *status == StatusCode::UNAUTHORIZED => ("Sign in needed", "Sign in to see this page."),
            Failure::Refused { status } if *status == StatusCode::TOO_MANY_REQUESTS => {
                ("Too many requests", "Wait a moment and try again.")
            }
            Failure::Refused { .. } => ("Not allowed", "You do not have access to this page."),
            Failure::Unidentified { .. } => ("Not available", "We could not check who you are. Try again in a moment."),
            Failure::TimedOut | Failure::Offline => ("Not available", "Check your connection and try again."),
            // The request did not arrive whole in time: an upload that stopped.
            Failure::Failed { status, .. } if *status == StatusCode::REQUEST_TIMEOUT => {
                ("Not received", "Check your connection and try again.")
            }
            Failure::WrongMethod
            | Failure::UnknownMethod
            | Failure::Rejected { .. }
            | Failure::Failed { .. }
            | Failure::Panicked { .. } => ("Something went wrong", "Please try again."),
        }
    }

    /// What went wrong, for the developer: set under `corten dev`, and logged instead in
    /// production. A debug build's error about the app's own code that the page's answer raises (a
    /// component the page draws that the app does not serve, a `Refresh` header, a write
    /// redirected outside `form-action`, a page answering a post to a path with no `GET`, a layout
    /// read the route says it gives and the page did not, a page whose answer type is not a page)
    /// keeps it outside `corten dev` too, so an app's router test names it; when the error page
    /// fails as well, its plain text keeps it.
    pub fn detail(&self) -> Option<&str> {
        match self {
            Failure::Rejected { detail, .. }
            | Failure::Failed { detail, .. }
            | Failure::Panicked { detail }
            | Failure::Unidentified { detail } => detail.as_deref(),
            _ => None,
        }
    }

    /// A failure Corten found the request at fault for, not the service: an unknown address (a
    /// handler's `Error::not_found()` among them), a wrong method, one no route has (501), a
    /// refusal and a request that did not parse, but not a 429, which slows a client down, so it
    /// starts no work for it. The error page for one starts the layout's reads and waits for them
    /// as a page does. A handler's other
    /// errors wait for none, whatever their status (a handler may answer a downstream outage with
    /// a 4xx), nor does plain text at a 5xx (a maintenance middleware's 503), nor a cross-site
    /// write, refused before anything else runs.
    fn request_at_fault(&self) -> bool {
        let fault = |status: &StatusCode| status.is_client_error() && *status != StatusCode::TOO_MANY_REQUESTS;
        match self {
            Failure::NotFound | Failure::WrongMethod | Failure::UnknownMethod => true,
            Failure::Refused { status } | Failure::Rejected { status, .. } => fault(status),
            Failure::CrossSite
            | Failure::Unidentified { .. }
            | Failure::Failed { .. }
            | Failure::Panicked { .. }
            | Failure::TimedOut
            | Failure::Offline => false,
        }
    }

    fn without_detail(self) -> Self {
        match self {
            Failure::Rejected { status, .. } => Failure::Rejected { status, detail: None },
            Failure::Failed { status, .. } => Failure::Failed { status, detail: None },
            Failure::Panicked { .. } => Failure::Panicked { detail: None },
            Failure::Unidentified { .. } => Failure::Unidentified { detail: None },
            other => other,
        }
    }
}

/// A debug build's error about the app's own code (a component the app does not serve, a hint no
/// control names, a `Refresh` header, a layout read the route says it gives and the page did not,
/// a page whose answer type is not a page), made by [`unserved`]: its answer is marked
/// [`KeepsDetail`].
#[derive(Debug)]
pub(crate) struct Unserved(String);

impl std::fmt::Display for Unserved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unserved {}

/// A debug build's error about the app's own code (`message` without the `corten: ` it is printed
/// with): kept on the error page's [`Failure::detail`] outside `corten dev`, and printed to stderr
/// there, since a router test has no logger.
#[cold]
pub(crate) fn unserved(dev: bool, message: String) -> Error {
    print_unserved(dev, &message);
    // Corten's, not the handler's, wherever it is answered: inside the handler, behind the app's
    // middleware, or in an answer's place.
    Error::corten(Unserved(message))
}

/// Prints a debug build's error about the app's code to stderr outside `corten dev`, where a router
/// test has no logger to show it.
#[cold]
fn print_unserved(dev: bool, message: &str) {
    if !dev {
        eprintln!("corten: {message}");
    }
}

/// Marks a debug build's failed answer whose message describes the app's code, not the request, so
/// the error page's [`Failure`] keeps it outside `corten dev` (where every other detail is only
/// logged). A release build never sets it.
#[derive(Clone, Copy)]
pub(crate) struct KeepsDetail;

/// Why a failed response failed, when its status and body do not say: set by the stage that
/// answered it, read when the error page is chosen.
#[derive(Clone, Copy)]
pub(crate) enum Cause {
    Panicked,
    TimedOut,
    Refused,
    Unidentified,
    /// The router's `501`: no route in the app has the method.
    UnknownMethod,
}

/// The error page of an app that gives none ([`crate::App::error_page`]): a plain document. An app
/// made by `corten new` has its own, in its layout. Every error page is sent with
/// `X-Robots-Tag: noindex`.
pub(crate) async fn default_error_page(failure: Failure, req: Req) -> HtmlResult {
    req.page(default_error_document(&req, failure))
}

fn default_error_document(req: &Req, failure: Failure) -> impl crate::view::Document + '_ {
    let (title, text) = failure.default_text();
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>{title}</title>
                <Corten />
            </head>
            <body>
                <main>
                    <h1>{title}</h1>
                    <p>{text}</p>
                    if let Some(detail) = failure.detail() {
                        <pre>{detail}</pre>
                    }
                </main>
            </body>
        </html>
    }
}

/// An error page with its arguments and state erased: the page's answer for a failed request,
/// from the failure and the request as [`Asked`] kept it ([`error_page`] finishes it).
pub(crate) type ErrorPage = dyn Fn(Failure, Parts) -> Pin<Box<dyn Future<Output = Response> + Send>> + Send + Sync;

/// The app's error page, as [`crate::App::error_page`] takes it: an async function of the
/// [`Failure`] and then extractors, as a handler's arguments are (`Req`, the caller who is
/// asking with `Option<Caller<Viewer>>`, `State<..>` of the state it is given), that answers
/// `req.page(..)`:
///
/// ```ignore
/// async fn error_page(failure: Failure, req: Req, viewer: Option<Caller<Viewer>>) -> HtmlResult {
///     let viewer = viewer.map(|Caller(v)| v);
///     req.page(html! { <Layout req={&req} viewer={viewer.as_ref()} title="..">..</Layout> })
/// }
/// ```
///
/// It is sent with the failure's status (or as it answers, when it redirects). The extractors see
/// the request's URL, `Cookie` and `Authorization` (so a caller is found as for the handler),
/// `Accept-Language` and its mode; not its other headers or its body. An extractor's rejection
/// is sent in the page's place, and is never shared, as a handler's extractor's is not:
///
/// ```
/// use corten::prelude::*;
///
/// async fn error_page(failure: Failure, req: Req) -> HtmlResult {
///     req.page(html! { <html><head><title>"Error"</title><Corten /></head><body><main>{failure.status().as_str()}</main></body></html> })
/// }
/// let _ = App::new(Routes::new()).error_page(error_page, ());
/// ```
///
/// So one that reads the body does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// async fn error_page(failure: Failure, req: Req, Form(_): Form<std::collections::HashMap<String, String>>) -> HtmlResult {
///     req.page(html! { <html><head><title>"Error"</title><Corten /></head><body><main>{failure.status().as_str()}</main></body></html> })
/// }
/// let _ = App::new(Routes::new()).error_page(error_page, ());
/// ```
pub trait ErrorPageFn<T, S>: Clone + Send + Sync + 'static {
    #[doc(hidden)]
    fn answer(self, failure: Failure, parts: Parts, state: S) -> impl Future<Output = Response> + Send + 'static;
}

macro_rules! error_page_fn {
    ($($t:ident),*) => {
        #[allow(non_snake_case, unused_mut, unused_variables)]
        impl<F, Fut, S, $($t,)*> ErrorPageFn<($($t,)*), S> for F
        where
            F: FnOnce(Failure, $($t,)*) -> Fut + Clone + Send + Sync + 'static,
            Fut: Future<Output = HtmlResult> + Send + 'static,
            S: Send + Sync + 'static,
            $($t: FromRequestParts<S> + Send + 'static,)*
        {
            fn answer(self, failure: Failure, mut parts: Parts, state: S) -> impl Future<Output = Response> + Send + 'static {
                async move {
                $(
                    let $t = match $t::from_request_parts(&mut parts, &state).await {
                        Ok(value) => value,
                        // About who is asking, as a handler's extractor's rejection may be.
                        Err(rejection) => return crate::cache::unshared(rejection.into_response()),
                    };
                )*
                match self(failure, $($t,)*).await {
                    Ok(res) => res.0,
                    Err(error) => error.into_response(),
                }
                }
            }
        }
    };
}
error_page_fn!();
error_page_fn!(T1);
error_page_fn!(T1, T2);
error_page_fn!(T1, T2, T3);
error_page_fn!(T1, T2, T3, T4);
error_page_fn!(T1, T2, T3, T4, T5);
error_page_fn!(T1, T2, T3, T4, T5, T6);

pub(crate) fn error_page_fn<H, T, S>(page: H, state: S) -> Box<ErrorPage>
where
    H: ErrorPageFn<T, S>,
    S: Clone + Send + Sync + 'static,
{
    Box::new(move |failure: Failure, parts: Parts| Box::pin(page.clone().answer(failure, parts, state.clone())))
}

/// The app's error page for `failure`, sent with its status.
pub(crate) async fn error_page(shared: &Shared, asked: Asked, failure: Failure) -> Response {
    let status = failure.status();
    let waits = failure.request_at_fault();
    let mut parts = asked.parts();
    // In a debug build, what the failure says is kept for the plain text below: an unlisted
    // component in the layout fails the page and its error page alike.
    let detail = if cfg!(debug_assertions) { failure.detail().map(str::to_owned) } else { None };
    // Started before the page is called, so they run beside its own reads.
    if let Some(here) = parts.extensions.get::<crate::layout::StartHere>().cloned() {
        here.at_error_page(&mut parts, waits);
    }
    let mut res = (shared.error_page)(failure, parts).await;
    if res.status().is_success() {
        *res.status_mut() = status;
    } else if !res.status().is_redirection() {
        // The error page itself failed (in a debug build, a component the app does not list):
        // plain text, so a broken error page cannot fail again, kept from a CDN as the failed page
        // was (an extractor's rejection is).
        tracing::error!(status = res.status().as_u16(), "corten: the error page failed");
        let plain = match detail {
            Some(detail) => (status, format!("The page could not be shown.\n\n{detail}")).into_response(),
            None => (status, "The page could not be shown.").into_response(),
        };
        res = crate::cache::unshared_in_place_of(res.extensions(), plain);
    }
    // Search engines skip it, whatever the layout says: the offline page is a 200.
    res.headers_mut().insert(HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex"));
    res
}

/// The request's credentials, `Cookie` and `Authorization`: read once, for the cache rules and for
/// the error page's caller. Values already in the request, shared, not copied.
#[derive(Default)]
pub(crate) struct Credentials {
    pub cookie: Option<HeaderValue>,
    pub authorization: Option<HeaderValue>,
}

/// What the stages know about the page before dispatch. A handler or its extractors see the
/// actual, possibly changed request, not this snapshot.
pub(crate) struct RequestPage {
    /// The request's mode where it is under no API. Under one it is `(Mode::Data, false)` and
    /// `accepts_html` is `false` whatever the request said ([`RequestPage::read`]), so a stage
    /// that reads either for a request under an API reads the request's headers instead.
    pub mode: (Mode, bool),
    pub accepts_html: bool,
    pub credentials: Credentials,
    #[cfg(debug_assertions)]
    pub form_check: Option<crate::security::FormCheck>,
}

impl RequestPage {
    /// `is_page`: the request is under no API. Under one, the stages ask nothing of the mode
    /// (every failure there is JSON, no answer a document the runtime swaps in, and a handler's
    /// `Req` reads the request itself), so neither header is looked up and the mode is set to a
    /// data client's, whatever the request said.
    pub(crate) fn read(headers: &HeaderMap, is_page: bool) -> Self {
        let (mode, accepts_html) = if is_page { Mode::read(headers, true) } else { ((Mode::Data, false), false) };
        RequestPage {
            mode,
            accepts_html,
            credentials: Credentials::default(),
            #[cfg(debug_assertions)]
            form_check: None,
        }
    }

    pub(crate) fn refusal_wants_html(&self, headers: &HeaderMap) -> bool {
        let (mode, fetched) = self.mode;
        // Unlike an ordinary failure, a refused whole-page fetch needs to ask for HTML.
        mode.swaps() || self.accepts_html || (fetched && accept(headers).contains("text/html"))
    }
}

/// What the error page's extractors see of a request, kept before the handler took it: what
/// [`Req`] reads and the credentials a caller is found by.
pub(crate) struct Asked {
    uri: Uri,
    mode: Mode,
    /// The runtime sent it ([`Mode::asked`]), which the error page's request says again.
    fetched: bool,
    accept_language: Option<HeaderValue>,
    nonce: Option<NonceSlot>,
    signal: crate::Signal,
    credentials: Credentials,
    /// A `HEAD` request, which leaves a redirect's notice for the `GET`.
    head: bool,
    /// The request's layout reads, which the error page draws too.
    here: Option<crate::layout::StartHere>,
}

impl Asked {
    /// What the error page's request needs, and no more: the error page's own `Req` reads the
    /// notice and the rest, so a request that answers without one builds no `Req` here.
    pub(crate) fn new(
        req: &Request,
        shared: &Shared,
        page: &mut RequestPage,
        nonce: Option<&NonceSlot>,
        signal: &crate::Signal,
    ) -> Self {
        let (mode, fetched) = page.mode;
        let head = req.method() == http::Method::HEAD;
        let here =
            if shared.layout_reads.is_empty() { None } else { req.extensions().get::<crate::layout::StartHere>().cloned() };
        Asked {
            uri: req.uri().clone(),
            mode,
            fetched,
            accept_language: req.headers().get(header::ACCEPT_LANGUAGE).cloned(),
            nonce: nonce.cloned(),
            signal: signal.clone(),
            credentials: std::mem::take(&mut page.credentials),
            head,
            here,
        }
    }

    fn path(&self) -> &str {
        self.uri.path()
    }

    /// The request again, for the error page's extractors.
    pub(crate) fn parts(self) -> Parts {
        let Asked {
            uri,
            mode,
            fetched,
            accept_language,
            nonce,
            signal,
            credentials: Credentials { cookie, authorization },
            head,
            here,
        } = self;
        let (mut parts, ()) = Request::new(()).into_parts();
        parts.uri = uri;
        if head {
            parts.method = http::Method::HEAD;
        }
        let mode = match mode {
            Mode::Navigation => Some(HeaderValue::from_static("nav")),
            Mode::Action => Some(HeaderValue::from_static("action")),
            Mode::Document if fetched => Some(HeaderValue::from_static("page")),
            Mode::Document | Mode::Data => None,
        };
        let kept = [
            (MODE_HEADER, mode),
            (header::ACCEPT_LANGUAGE, accept_language),
            (header::COOKIE, cookie),
            (header::AUTHORIZATION, authorization),
        ];
        parts.headers.reserve(kept.iter().filter(|(_, value)| value.is_some()).count());
        for (name, value) in kept {
            if let Some(value) = value {
                parts.headers.insert(name, value);
            }
        }
        if let Some(nonce) = nonce {
            parts.extensions.insert(nonce);
        }
        // An optional caller that cannot be looked up is none there, so the page is drawn signed
        // out rather than not at all.
        signal.mark_error_page();
        parts.extensions.insert(signal);
        if let Some(here) = here {
            parts.extensions.insert(here);
        }
        parts
    }
}

/// Everything a request needs from the app: the error page, where scripts live.
pub(crate) struct Shared {
    pub error_page: Box<ErrorPage>,
    pub assets: Option<Arc<Assets>>,
    pub scripts_dir: String,
    /// The import map's JSON: the runtime, the app's typed events and views.
    pub import_map: String,
    /// Extra `<head>` tags from the app's configuration (manifest link, theme color, service
    /// worker), rendered once.
    pub head_extra: String,
    /// Hash of what the page around `<main>` shows that a navigation cannot update: runtime and
    /// asset versions.
    pub key_base: u64,
    /// The PWA's offline page path; Corten answers it when the app has no route for it.
    pub offline: Option<String>,
    /// The app's message catalogs, negotiated per request by [`Req::t`].
    pub locales: Option<&'static [&'static str]>,
    /// [`crate::App::client_zone`]: the runtime keeps the browser's time zone in a cookie.
    pub client_zone: bool,
    /// [`crate::App::zoned_dates`]: dates are written in the visitor's zone while Corten renders.
    #[cfg(feature = "zones")]
    pub zoned_dates: bool,
    /// The app is HTTPS only ([`crate::security::Policy::hsts`]): when there is no
    /// `Sec-Fetch-Site`, a WebSocket handshake's `Origin` must be `https` or loopback
    /// ([`crate::upgrade::Upgrade`]), and a redirect's notice never rides in
    /// [`PLAIN_NOTICE_COOKIE`].
    pub https_only: bool,
    /// Dev mode: error pages show the error.
    pub dev: bool,
    /// The names of the components the app lists (`App::components` and `Area::components`).
    pub components: std::collections::HashSet<&'static str>,
    /// Each area stylesheet (`Area::components`): the prefixes whose pages link it and its `<link>`.
    pub sections: Vec<(Vec<String>, String)>,
    /// The section (an index in `sections`) whose stylesheet has a component's rules.
    pub section_of: std::collections::HashMap<&'static str, usize>,
    /// The proxies whose `X-Forwarded-For` [`crate::ClientIp`] follows ([`crate::security::Policy::proxy`]).
    pub proxies: Vec<crate::client::Network>,
    /// The other sites [`crate::security::Policy::allow_origin`] lets write, for a switch to a
    /// WebSocket, which [`crate::upgrade::Upgrade`] checks as a write.
    pub allowed_origins: Vec<String>,
    /// What each area and API sets, by path: an API's `Api::allow_origin` sites may also switch
    /// to a WebSocket under it ([`crate::upgrade::Upgrade`]). None outside an app.
    pub scopes: Option<Arc<crate::app::Scopes>>,
    /// The app's route patterns, its own and its areas', each with whether it has a `GET`
    /// handler ([`Req::serves`]).
    pub pages: Box<[(&'static str, bool)]>,
    /// Paths no page is at: Corten's own and the APIs'.
    pub not_pages: crate::app::NotPages,
    /// The app's work that handlers finish ([`crate::Signal::finish`]).
    pub finishing: Arc<crate::task::Finishing>,
    /// The values only the layout shows ([`crate::App::layout_read`]), started for each request
    /// for a whole document.
    pub layout_reads: Box<[Arc<dyn crate::layout::Erased>]>,
    /// The `Public` pages, JSON, text and files the app keeps to give again ([`crate::App::kept_answers`]); none with
    /// a bound of 0, or without a `Public` route it keeps. Under `corten dev` it keeps and gives none
    /// (`crate::kept::Verdict`).
    pub kept: Option<crate::kept::Answers>,
}

impl Shared {
    pub(crate) fn new(error_page: Box<ErrorPage>, assets: Option<Arc<Assets>>, head_extra: String) -> Self {
        let scripts_dir = assets.as_ref().map_or_else(|| "/assets/scripts/".to_string(), |a| a.scripts_dir().to_string());
        let import_map = crate::import_map(
            assets.as_ref().and_then(|a| a.events()).as_deref(),
            assets.as_ref().and_then(|a| a.views()).as_deref(),
            &assets.as_ref().map(|a| a.imported()).unwrap_or_default(),
        );
        let mut hasher = std::hash::DefaultHasher::new();
        crate::runtime_version().hash(&mut hasher);
        scripts_dir.hash(&mut hasher);
        import_map.hash(&mut hasher);
        head_extra.hash(&mut hasher);
        Shared {
            error_page,
            finishing: Arc::default(),
            assets,
            scripts_dir,
            import_map,
            head_extra,
            key_base: hasher.finish(),
            offline: None,
            locales: None,
            client_zone: false,
            #[cfg(feature = "zones")]
            zoned_dates: false,
            https_only: false,
            dev: false,
            components: Default::default(),
            sections: Vec::new(),
            section_of: Default::default(),
            proxies: Vec::new(),
            allowed_origins: Vec::new(),
            scopes: None,
            pages: Box::default(),
            not_pages: Default::default(),
            layout_reads: Box::default(),
            kept: None,
        }
    }
}

/// Used by handlers that run without an [`crate::App`] (unit tests of a bare router).
static DEFAULT: LazyLock<Arc<Shared>> =
    LazyLock::new(|| Arc::new(Shared::new(error_page_fn(default_error_page, ()), None, String::new())));

/// A patch builder borrowed from a request checked by [`Req::action`].
/// It consumes itself to answer once, just as [`FormPatch`] draws once. It has no public
/// constructor and is neither `Clone` nor `Copy`; obtain another by checking the request again.
///
/// ```
/// use corten::prelude::*;
/// #[derive(Id)]
/// struct SavedId;
/// fn save(req: &Req) -> HtmlResult {
///     if let Some(action) = req.action() {
///         return action.patch(html! { <p id={SavedId}>"Saved"</p> });
///     }
///     req.redirect(&corten::Local::parse("/").unwrap())
/// }
/// ```
///
/// A request alone cannot build a patch, even after a boolean mode check:
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
/// fn unchecked(req: &Req) -> HtmlResult {
///     if req.mode != Mode::Action { return Err(corten::Error::not_found()); }
///     req.patch(html! {})
/// }
/// ```
///
/// Nor can it build a patch with a status:
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
/// fn unchecked(req: &Req) -> HtmlResult {
///     req.patch_with_status(corten::http::StatusCode::OK, html! {})
/// }
/// ```
///
/// Its field is private:
///
/// ```compile_fail,E0423
/// use corten::{prelude::*, Action};
/// fn unchecked(req: &Req) {
///     let action = Action(req);
/// }
/// ```
///
/// It cannot be cloned:
///
/// ```compile_fail,E0599
/// use corten::{prelude::*, Action};
/// fn duplicate(action: Action<'_>) {
///     let another = action.clone();
/// }
/// ```
///
/// Nor copied to answer twice:
///
/// ```compile_fail,E0382
/// use corten::{prelude::*, Action};
/// fn duplicate(action: Action<'_>) -> HtmlResult {
///     let first: HtmlResult = action.patch(html! {});
///     action.patch(html! {})
/// }
/// ```
///
/// Its borrow prevents using it after writing that request's mode:
///
/// ```compile_fail,E0506
/// use corten::prelude::*;
/// fn changed(mut req: Req) -> HtmlResult {
///     let Some(action) = req.action() else { return Err(corten::Error::not_found()); };
///     req.mode = Mode::Document;
///     action.patch(html! {})
/// }
/// ```
pub struct Action<'r>(&'r Req);

impl Action<'_> {
    /// Answers a `<form data-patch>` submit with fragments: the runtime replaces each element on
    /// the page that has the id of one of `view`'s top-level elements. One without an id would
    /// be dropped in the browser, so `view` is a [`Patch`](crate::view::Patch), which the compiler
    /// checks: usually a component declared `-> impl Patch` whose root has a `#[derive(Id)]` id.
    /// It is any [`HtmlResult`], `HtmlResult<Patches>` too ([`crate::Patches`]).
    ///
    /// Obtain this builder from [`Req::action`], or answer both modes with [`Req::patch_or`].
    /// A build that generates code also refuses a direct `html!` whose literal top level would
    /// lose an element when sent whole. A paragraph before a row makes the browser drop the row:
    ///
    /// ```compile_fail,E0080
    /// use corten::{prelude::*, Action};
    /// #[derive(Id)]
    /// struct StatusId;
    /// #[derive(Id)]
    /// struct RowId;
    /// fn answer(action: Action<'_>) -> HtmlResult {
    ///     action.patch(html! {
    ///         <p id={StatusId}>"Saved"</p>
    ///         <tr id={RowId}><td>"1"</td></tr>
    ///     })
    /// }
    /// # std::hint::black_box(answer as fn(Action<'_>) -> HtmlResult);
    /// ```
    ///
    /// Starting the patch with a row instead keeps the paragraph and the later row:
    ///
    /// ```
    /// use corten::{prelude::*, Action};
    /// #[derive(Id)]
    /// struct PatchExampleStatusId;
    /// #[derive(Id)]
    /// struct PatchExampleRowId(u32);
    /// fn answer(action: Action<'_>) -> HtmlResult {
    ///     action.patch(html! {
    ///         <tr id={PatchExampleRowId(1)}><td>"1"</td></tr>
    ///         <p id={PatchExampleStatusId}>"Saved"</p>
    ///         <tr id={PatchExampleRowId(2)}><td>"2"</td></tr>
    ///     })
    /// }
    /// # std::hint::black_box(answer as fn(Action<'_>) -> HtmlResult);
    /// ```
    pub fn patch<For, Kind: crate::answer::PatchingKind>(
        self,
        view: impl crate::view::Patch,
    ) -> crate::Result<HtmlResponse<For, Kind>> {
        self.patch_with_status(StatusCode::OK, view)
    }

    /// Same as [`Action::patch`] with another status.
    pub fn patch_with_status<For, Kind: crate::answer::PatchingKind>(
        self,
        status: StatusCode,
        view: impl crate::view::Patch,
    ) -> crate::Result<HtmlResponse<For, Kind>> {
        view.__check_whole_patch();
        let mut body = String::new();
        let drawing = crate::form::Drawing::start();
        // A debug build notes the places a patch draws: a patch is not a page, so none is filled.
        #[cfg(debug_assertions)]
        {
            let (rendered, places) = crate::gather(&crate::layout::SLOTS, crate::layout::Places::default(), || {
                self.0.render_into(view, &mut body, false)
            });
            rendered?;
            if let Some(crate::layout::Slot { name, .. }) = places.and_then(|places| places.slots.first().copied()) {
                return Err(self.0.unserved(format!(
                    "the patch renders later::<{name}>(), which only a page fills, so nothing is drawn there: pass the value to the patch's view instead"
                )));
            }
        }
        #[cfg(not(debug_assertions))]
        self.0.render_into(view, &mut body, false)?;
        // In an app whose areas have stylesheets, a patch under one ends with their links, after
        // its elements, where adding them moves nothing; the runtime takes them out first.
        if !self.0.shared.sections.is_empty() {
            self.0.section_links(&mut body);
        }
        #[cfg(debug_assertions)]
        self.0.parses_whole(&body)?;
        let mut res = html_response(status, body, Some(PATCH_HEADER), HeaderValue::from_static(VARY));
        // A form's submit key is new on every render, so this body's tag would never match.
        if drawing.drew() {
            self.0.signal.mark_key_drawn();
            res.extensions_mut().insert(crate::cache::Unrepeatable);
        }
        Ok(HtmlResponse::new(res))
    }
}

/// What draws the form's patch in [`Req::invalid_with`]: a patch and nothing else.
pub struct FormPatch<'r>(&'r Req);

impl FormPatch<'_> {
    /// The form, re-rendered with the errors, as the refusal's patch.
    /// Like [`Action::patch`], this refuses literal top-level elements a browser would not
    /// keep as written. A cell after a first row is wrapped in a new row:
    ///
    /// ```compile_fail,E0080
    /// use corten::{prelude::*, DrawnPatch, FormPatch};
    /// #[derive(Id)]
    /// struct RowId;
    /// #[derive(Id)]
    /// struct CellId;
    /// fn answer(form: FormPatch<'_>) -> corten::Result<DrawnPatch> {
    ///     form.draw(html! {
    ///         <tr id={RowId}><td>"1"</td></tr>
    ///         <td id={CellId}>"2"</td>
    ///     })
    /// }
    /// # std::hint::black_box(answer as fn(FormPatch<'_>) -> corten::Result<DrawnPatch>);
    /// ```
    pub fn draw(self, view: impl crate::view::Patch) -> Result<DrawnPatch> {
        view.__check_whole_patch();
        let mut body = String::new();
        self.0.render_into(view, &mut body, false)?;
        self.0.section_links(&mut body);
        #[cfg(debug_assertions)]
        self.0.parses_whole(&body)?;
        Ok(DrawnPatch(body))
    }
}

/// A patch [`FormPatch::draw`] drew, which [`Req::invalid_with`] sends with the refusal's status.
pub struct DrawnPatch(String);

/// The request as a handler answers it: which [`Mode`] the client asked in, and the methods
/// that build each kind of response. Every handler that returns HTML takes one.
pub struct Req {
    pub mode: Mode,
    nonce: Option<NonceSlot>,
    uri: Uri,
    accept_language: Option<HeaderValue>,
    notice: Option<Notice>,
    /// A write from a plain `http://` origin that is not loopback ([`plain_origin`]): its notice
    /// rides in [`PLAIN_NOTICE_COOKIE`].
    plain_write: bool,
    /// The request is a write (not `GET` or `HEAD`), which [`Req::resend_to`] needs.
    write: bool,
    /// This action write asks for a whole page, as read from the request this `Req` was taken with.
    pub(crate) whole_action: bool,
    /// The runtime sent it ([`Mode::asked`]): a redirect to a place or another site is then
    /// named in `corten-location`, as `fetch` cannot follow one (#1034).
    fetched: bool,
    /// Layout reads are available if the handler draws a whole page. The handler can still
    /// change `mode`; fragments never fill their places.
    fills: bool,
    /// For a write the runtime sent whose own page is filled after it answers, taken by middleware
    /// or a raw route: the request's head as it was then, which a page this makes carries, so its reads
    /// start from it (`layout::fill_made_early`). Its number among the heads kept on the request's
    /// signal ([`crate::Signal::keep_early_head`]), 0 for none: a byte in the padding, where the head itself made
    /// every `Req` 8 bytes larger, which every request that takes one paid in a copy.
    early: u8,
    shared: Arc<Shared>,
    signal: crate::Signal,
    /// A debug build's: the request is to a route with named posts, at one of their addresses
    /// (`do=..`), where the page it draws stays ([`Req::check_action_forms`]).
    #[cfg(debug_assertions)]
    at_post: bool,
}

/// What a write said on the page it redirected to ([`Req::redirect_with_notice`]): "Batch 3517
/// deleted." Text, escaped where it renders, for the page's toaster or status line. Rendered in
/// `html!` it counts as drawn: a navigation's page that rendered it does not also hand it to the
/// runtime, and one whose layout (not run for a navigation) holds it does.
#[derive(Clone)]
pub struct Notice {
    text: Box<str>,
    signal: crate::Signal,
    /// Which cookies it was read from, which the answer removes.
    gone: Gone,
}

/// The notice cookies a request carried that its page's answer removes: none for one the runtime
/// sent back ([`Gone::Sent`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gone {
    Host,
    Plain,
    Both,
    /// The notice the page on screen drew, sent back by the runtime (`corten-notice: p=<path>&m=<text>`)
    /// when that page reads itself again (`ReadAgain`), so the read draws it as the page did and
    /// is not taken for a change. Only a `GET` from the page's own origin sends it: a header
    /// another site cannot set on a request the browser sends for it.
    Sent,
}

impl Notice {
    /// The text, for something other than the page (a log line). Drawn from this, it does not
    /// count as drawn: render the `Notice` itself.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The request's notice: the cookie's, when it was written for this path; else, for a `GET`
    /// (`sent`), the one the runtime sends back as the page that drew it reads itself again.
    fn of(headers: &HeaderMap, path: &str, signal: &crate::Signal, plain: bool, sent: bool) -> Option<Notice> {
        if let Some((value, gone)) = notice_cookie(headers, plain) {
            let (mut to, mut text) = (None, None);
            for (key, value) in form_urlencoded::parse(value.as_bytes()) {
                match &*key {
                    "p" => to = Some(value),
                    "m" => text = Some(value),
                    _ => {}
                }
            }
            if to.is_some_and(|to| *to == *path_key(path)) {
                return Some(Notice { text: text.unwrap_or_default().into(), signal: signal.clone(), gone });
            }
        }
        // The header first: a request without it (all but a read again) looks at nothing else.
        if !sent {
            return None;
        }
        let value = headers.get(NOTICE_HEADER)?;
        if headers.get("sec-fetch-site").is_some_and(|site| site.as_bytes() != b"same-origin") {
            return None;
        }
        // For the page that drew it: a read again the server redirects elsewhere (`fetch` keeps
        // the header) does not draw it there.
        let (mut to, mut text) = (None, None);
        for (key, value) in form_urlencoded::parse(value.as_bytes()) {
            match &*key {
                "p" => to = Some(value),
                "m" => text = Some(value),
                _ => {}
            }
        }
        let text = text?;
        (to.is_some_and(|to| *path_key(&to) == *path_key(path)) && text.len() <= NOTICE_MAX).then(|| Notice {
            text: text.into(),
            signal: signal.clone(),
            gone: Gone::Sent,
        })
    }
}

/// The request's notice cookie and the cookies its answer removes, in one pass over the cookies:
/// the `__Host-` one's text first; the plain one when `plain` (the app is not HTTPS only) and
/// the browser does not count the page's origin as secure (no `Sec-Fetch-Site`).
fn notice_cookie(headers: &HeaderMap, plain: bool) -> Option<(&str, Gone)> {
    let (mut host, mut plain_value) = (None, None);
    for pair in headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')) {
        let Some((name, value)) = pair.trim().split_once('=') else { continue };
        if name == NOTICE_COOKIE && host.is_none() {
            host = Some(value);
        } else if plain && name == PLAIN_NOTICE_COOKIE && plain_value.is_none() {
            plain_value = Some(value);
        }
    }
    let plain_value = plain_value.filter(|_| !headers.contains_key("sec-fetch-site"));
    match (host, plain_value) {
        (Some(value), None) => Some((value, Gone::Host)),
        (Some(value), Some(_)) => Some((value, Gone::Both)),
        (None, Some(value)) => Some((value, Gone::Plain)),
        (None, None) => None,
    }
}

/// Whether a write comes from a page on a plain `http://` origin that is not loopback
/// (`localhost`, a name under it, `127.0.0.0/8`, `[::1]`), which a browser does not count as
/// secure, so it refuses a `Secure` cookie from it: no `Sec-Fetch-Site` (which the page reading
/// the notice is held to as well), and an `Origin` of this host, as the same-origin check on a
/// write without that header requires ([`crate::security::Policy::same_origin`]), a default
/// port written or left out alike.
pub(crate) fn plain_origin(uri: &Uri, headers: &HeaderMap) -> bool {
    if headers.contains_key("sec-fetch-site") {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return false };
    let Some(host) = crate::security::request_host(uri, || headers.get(header::HOST)).and_then(|at| at.text()) else {
        return false;
    };
    matches!(crate::security::on_host(origin, host), Some(("http", at)) if !crate::security::loopback(at))
}

/// The page a notice is for, as its cookie names it: a hash of the path with its escapes decoded,
/// so the link the app wrote (`/items/a b` as `a%20b`, a [`crate::Local`] with a `{`) and the path
/// the browser asks for (which escapes the `{`) name one page, in 16 characters however long it is.
/// An escaped `/` stays escaped, since it is part of one segment (`%2f` and `%2F` are the same).
pub(crate) fn path_key(path: &str) -> String {
    crate::ascii::hex(path_hash(path.as_bytes()), &mut [0; 16]).to_string()
}

/// The hash [`path_key`] writes: of the path with its escapes decoded, an escaped `/` kept.
pub(crate) fn path_hash(bytes: &[u8]) -> u64 {
    let (mut hash, mut i) = (crate::fnv::OFFSET, 0);
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        let byte = match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            // An escaped `/` stays escaped: `/a%2Fb` is one segment, not the page `/a/b`.
            (b'%', Some(hi), Some(lo)) if hi * 16 + lo != u32::from(b'/') => {
                i += 2;
                (hi * 16 + lo) as u8
            }
            // In one case of its digits, so `%2f` and `%2F` are one segment's.
            (b'f', ..) if i >= 2 && bytes[i - 2] == b'%' && bytes[i - 1] == b'2' => b'F',
            (byte, ..) => byte,
        };
        hash = crate::fnv::extend(hash, &[byte]);
        i += 1;
    }
    hash
}

impl Render for Notice {
    fn render(&self, out: &mut String) {
        self.signal.mark_notice_drawn();
        crate::view::escape_into(&self.text, out)
    }
}

impl std::fmt::Debug for Notice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Notice").field(&self.text).finish()
    }
}

impl PartialEq for Notice {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
    }
}

impl<St: Send + Sync> FromRequestParts<St> for Req {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &St) -> std::result::Result<Self, Self::Rejection> {
        let shared = parts.extensions.get::<crate::Signal>().and_then(crate::Signal::shared).unwrap_or(&DEFAULT).clone();
        // A page route started the layout's reads as it was called; a route of Corten's own
        // starts them here, after the middleware, beside the handler's own reads.
        if !shared.layout_reads.is_empty() {
            if let Some(here) = parts.extensions.get::<crate::layout::StartHere>().cloned() {
                here.extracted(parts);
            }
        }
        // A HEAD request (a link checker, a preview) gets no body, so it leaves the notice for the
        // page's GET.
        let mut req =
            Req::new(&parts.headers, &parts.extensions, &parts.uri, shared, &parts.method, parts.method != http::Method::HEAD);
        // Middleware or a raw route can draw a page from the head it took, including after a
        // typed route answered a forwarded request. The typed endpoint handles its own head.
        if req.fills && req.write && req.signal.accepts_early_heads() && !crate::layout::LateWrite::reached(&parts.extensions) {
            req.early = req.signal.keep_early_head(parts.clone());
        }
        Ok(req)
    }
}

/// The signal of a request a middleware passed on without one ([`crate::signal::Detached`]),
/// shared by every `Req` of it and read as its answer comes back, or a signal of the `Req`'s own
/// where there is none (a bare router in a test).
#[cold]
#[inline(never)]
fn detached(extensions: &Extensions) -> crate::Signal {
    extensions.get::<crate::signal::Detached>().map_or_else(crate::Signal::default, |detached| detached.0.clone())
}

impl Req {
    /// `notice`: read the request's notice (its answer then removes it). Only a write's `Origin`
    /// is looked at for the plain cookie; a `GET` looks up one header more, the notice a page
    /// reading itself again sends back.
    pub(crate) fn new(
        headers: &HeaderMap,
        extensions: &Extensions,
        uri: &Uri,
        shared: Arc<Shared>,
        method: &http::Method,
        notice: bool,
    ) -> Self {
        // Middleware and earlier extractors may have changed either header since the stages.
        let (mode, fetched) = Mode::asked(headers);
        let signal = extensions.get::<crate::Signal>();
        let write = !matches!(*method, http::Method::GET | http::Method::HEAD);
        let whole_action =
            mode == Mode::Action && write && signal.map_or_else(|| prefers_whole(headers), |signal| signal.draws_whole(headers));
        let signal = signal.cloned().unwrap_or_else(|| detached(extensions));
        Req {
            mode,
            nonce: extensions.get::<NonceSlot>().cloned(),
            uri: uri.clone(),
            accept_language: headers.get(header::ACCEPT_LANGUAGE).cloned(),
            notice: if notice {
                Notice::of(headers, uri.path(), &signal, !shared.https_only, *method == http::Method::GET)
            } else {
                None
            },
            plain_write: write && !shared.https_only && plain_origin(uri, headers),
            write,
            whole_action,
            fetched,
            fills: !shared.layout_reads.is_empty()
                && (extensions.get::<crate::layout::StartHere>().is_some() || (write && signal.fills_late())),
            early: 0,
            shared,
            signal,
            #[cfg(debug_assertions)]
            at_post: extensions.get::<crate::router::HasPosts>().is_some() && at_action(uri.query()),
        }
    }

    /// The key of the page around `<main>`: the app's versions, who it is for (the callers the
    /// request read, read when the page renders, after the handler's extractors ran) and which
    /// layout rendered it (`shell`, from the document's `html!`).
    fn key(&self, shell: u64) -> u64 {
        // What the page's area policy adds (`Area::policy`): a document keeps the CSP it loaded
        // with, so a navigation to a page with another loads it in full.
        let area = self.nonce.as_ref().map_or(0, |slot| slot.1);
        // A locale the URL chose: a page in another one is drawn around another layout. One
        // `Accept-Language` chose is the browser's, the same from page to page.
        let locale = self.signal.locale().map_or(0, |index| (index as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15));
        self.shared.key_base ^ self.signal.callers().rotate_left(1) ^ shell ^ area ^ locale
    }

    /// When the work for this request should stop, and why: the server's `request.signal`. See
    /// [`crate::Signal`]; work the handler awaits stops without it.
    pub fn signal(&self) -> &crate::Signal {
        &self.signal
    }

    /// The request path.
    pub fn path(&self) -> &str {
        self.uri.path()
    }

    /// The app's messages (from [`crate::i18n::messages!`]) in the best locale for this request's
    /// `Accept-Language`, or the one the handler chose from the URL ([`Req::set_locale`]):
    /// `let t: Msg = req.t();`.
    pub fn t<M: crate::i18n::Messages>(&self) -> M {
        let t: M = self.messages();
        #[cfg(debug_assertions)]
        self.signal.read_locale(t.locale());
        t
    }

    fn messages<M: crate::i18n::Messages>(&self) -> M {
        match self.shared.locales {
            // The app's own messages: the request's locale, negotiated once.
            Some(locales) if std::ptr::eq(locales, M::LOCALES) || locales == M::LOCALES => {
                M::from_index(self.locale_index(locales))
            }
            // Another messages type: the app's locale by its tag, as the URL chose it.
            Some(locales) => match self.signal.locale() {
                Some(index) => M::for_locale(locales.get(index).copied().unwrap_or(locales[0])),
                None => self.negotiate::<M>(),
            },
            None => match self.signal.locale() {
                Some(index) => M::from_index(index),
                None => self.negotiate::<M>(),
            },
        }
    }

    /// The request's locale by its index in the app's `locales`: the one the handler chose, else
    /// `Accept-Language`'s, negotiated on first use and kept for the rest of the request.
    fn locale_index(&self, locales: &[&str]) -> usize {
        if let Some(index) = self.signal.known_locale() {
            return index;
        }
        // Noted for the answer's `Vary` (`vary_on_language`), however late it is read.
        self.signal.ask_language();
        let index = crate::i18n::negotiate(locales, self.accept_language());
        self.signal.negotiated_locale(index);
        index
    }

    /// `M` in the locale `Accept-Language` asks for, noted for the answer's `Vary`.
    fn negotiate<M: crate::i18n::Messages>(&self) -> M {
        self.signal.ask_language();
        M::negotiate(self.accept_language())
    }

    /// Answers in `locale`, the one the page's URL names (a [`crate::i18n::Locale`] route field,
    /// `/{lang}/items/{id}` with `lang: Locale<Msg>`), rather than the one `Accept-Language`
    /// asks for: `req.t()`, `req.lang()` and the error page's follow it, and the answer does not
    /// vary on `Accept-Language`, so a cache keys the page on its URL alone, one copy per locale.
    /// Call it before anything reads the locale (a debug build stops one after `req.t()` or
    /// `req.lang()` read another), in an app with [`crate::App::messages`]. A client navigation to a page in another locale loads it
    /// in full, since the layout around `<main>` is in the other language.
    ///
    /// ```
    /// use corten::{i18n::{Locale, Messages as _}, prelude::*, Params};
    ///
    /// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
    ///
    /// #[derive(Route)]
    /// #[route("/{lang}/listings")]
    /// struct Listings { lang: Locale<Msg> }
    ///
    /// async fn listings(req: Req, Params(at): Params<Listings>) -> HtmlResult {
    ///     req.set_locale(at.lang);
    ///     let t: Msg = req.t();
    ///     let lang = req.lang();
    ///     req.page(html! { <html lang={lang}><head><title>{t.item_listings()}</title><Corten /></head><body><main></main></body></html> })
    /// }
    /// # let _ = listings;
    /// assert_eq!(Listings { lang: Locale::of(Msg::for_locale("fr")) }.href(), "/fr/listings");
    /// ```
    pub fn set_locale<M: crate::i18n::Messages>(&self, locale: crate::i18n::Locale<M>) {
        debug_assert!(
            self.shared.locales.is_none_or(|locales| locales == M::LOCALES),
            "corten: req.set_locale with a messages type whose locales are not the app's (App::messages)"
        );
        let index = locale.messages().index();
        // A locale already read (req.t(), req.lang()) drew part of the page in it: changing it now
        // would label the page in one language and draw it in another. Compared by tag, so a second
        // messages type read first in the same language stands.
        #[cfg(debug_assertions)]
        {
            let chosen = locale.messages().locale();
            let read = self.signal.locales_read();
            assert!(
                read.iter().all(|read| *read == chosen),
                "corten: req.set_locale({chosen}) after req.t() or req.lang() read the locale as {}; call it first",
                read.join(" and ")
            );
        }
        self.signal.set_locale(index);
    }

    /// The visitor's time zone (`zones` feature, [`crate::App::client_zone`]), with its rules: the
    /// zone a page draws a form's dates and times in (`DrawZone::from(req.zone())`). The form sends
    /// that zone back, and its post reads a picked date and time, or where a picked day
    /// (`<input type="date">`) begins, in it (`day.start(&input.zone)`), not in the post's
    /// `req.zone()`, which can differ from the page's ([`crate::form::FormZone`]).
    /// UTC until the browser has reported it (its first page) and for a name the tz database
    /// lacks. Looked up in the tz database at each call, so a handler keeps it. With
    /// [`crate::App::zoned_dates`] a page needs it for nothing else: while Corten renders the
    /// answer, `t.date`, `t.time` and `t.date_time` write in it unless `.zone(..)` chooses
    /// another. A known zone makes the answer private. For a [`crate::Public`] answer, which is the same for everyone,
    /// it is UTC and dates are written in UTC (corten-ui's `LocalTime` writes one again in the
    /// browser's zone).
    #[cfg(feature = "zones")]
    pub fn zone(&self) -> crate::i18n::Visitor {
        // The request's signal holds the zone the browser reported, read once for the request.
        let zone = self.signal.zone();
        let Some(name) = zone.as_ref().map(crate::client::ZoneName::as_str) else {
            #[cfg(debug_assertions)]
            if !self.shared.client_zone {
                tracing::warn!(
                    "corten: req.zone() is UTC: the app does not learn its visitors' time zones; add App::client_zone()"
                );
            } else if self.signal.is_for_everyone() && !self.signal.is_error_page() {
                tracing::warn!("corten: req.zone() is UTC in a Public answer, which is the same for everyone");
            }
            return crate::i18n::Visitor::default();
        };
        let zone = crate::i18n::Visitor::named(name);
        if zone.is_known() {
            self.signal.mark_personal();
        }
        zone
    }

    /// While Corten renders this request's answer: dates in the visitor's zone.
    #[cfg(feature = "zones")]
    fn zone_scope(&self) -> Option<crate::i18n::ZoneScope> {
        self.shared.zoned_dates.then(|| crate::i18n::ZoneScope::enter(crate::i18n::Scope::of(self.signal.zone(), &self.signal)))
    }

    fn accept_language(&self) -> Option<&str> {
        self.accept_language.as_ref().and_then(|v| v.to_str().ok())
    }

    /// The request's locale (`"en"` without [`crate::App::messages`]), for `<html lang>`: the one
    /// the handler chose ([`Req::set_locale`]), else the one negotiated from `Accept-Language`.
    pub fn lang(&self) -> &'static str {
        let lang = match self.shared.locales {
            Some(locales) => locales.get(self.locale_index(locales)).copied().unwrap_or(locales[0]),
            None => "en",
        };
        #[cfg(debug_assertions)]
        self.signal.read_locale(lang);
        lang
    }

    /// A page: `doc` is the whole document, the app's layout with the page in it
    /// (`html! { <Layout req={req} title="About">..</Layout> }`). A browser gets all of it; a
    /// client navigation (and a `GET` form the runtime sends) gets the title, the page's head tags
    /// and `<main>`'s children, and the rest of the layout does not run. A write's own page is whole
    /// in document mode or an action with `Prefer: corten-draws=whole`; navigation mode and a legacy
    /// action still get a fragment. For a whole action answer the runtime draws what differs around
    /// `<main>`, including its [`crate::LayoutRead`]s, as for the page a write redirects to.
    pub fn page<For>(&self, doc: impl Document) -> crate::Result<HtmlResponse<For>> {
        self.page_with_status(StatusCode::OK, doc)
    }

    /// [`Req::page`] with another status.
    pub fn page_with_status<For>(&self, status: StatusCode, doc: impl Document) -> crate::Result<HtmlResponse<For>> {
        self.page_as(status, doc)
    }

    /// The page, as an answer of any kind: `Req::screen`'s page is its `Kind`'s, made in place
    /// rather than moved out of an `HtmlResponse<For>`.
    fn page_as<For, Kind>(&self, status: StatusCode, doc: impl Document) -> crate::Result<HtmlResponse<For, Kind>> {
        // The last size of each part, so the buffer is allocated once.
        static FULL: AtomicUsize = AtomicUsize::new(16 * 1024);
        static SWAP: AtomicUsize = AtomicUsize::new(16 * 1024);
        // A write's own page is whole, as without JavaScript and as the page a write redirects to,
        // so what the write changed around `<main>` is drawn, for a runtime that draws one (#1370).
        let swap = self.mode.swaps() && !(self.mode == Mode::Action && self.whole_action);
        let (part, size) = if swap { (Part::Swap, &SWAP) } else { (Part::Full, &FULL) };
        let mut out = String::with_capacity(size.load(Ordering::Relaxed));
        HEAD_AT.set(None);
        crate::view::SHELL.set(0);
        let drawing = crate::form::Drawing::start();
        // A full page's custom properties (`style={..}`) go in one style block its CSP allows by
        // hash; a swap's are set by the runtime, under the CSP the document loaded with.
        // The places the layout draws its reads (`later`): noted only in an app that starts some,
        // and in a debug build, which checks each is one the app starts. An app without them
        // renders as it did before layout reads.
        let (modules, vars, places) = if cfg!(debug_assertions) || !self.shared.layout_reads.is_empty() {
            let render = || {
                if swap {
                    (self.render_into(Parted(doc, part), &mut out, true), String::new())
                } else {
                    crate::style::collect_vars(|| self.render_into(Parted(doc, part), &mut out, true))
                }
            };
            let ((modules, vars), places) = crate::gather(&crate::layout::SLOTS, crate::layout::Places::default(), render);
            (modules?, vars, places.unwrap_or_default())
        } else if swap {
            (self.render_into(Parted(doc, part), &mut out, true)?, String::new(), crate::layout::Places::default())
        } else {
            let (modules, vars) = crate::style::collect_vars(|| self.render_into(Parted(doc, part), &mut out, true));
            (modules?, vars, crate::layout::Places::default())
        };
        let Some(at) = HEAD_AT.take() else {
            return Err(Error::corten("corten: the document's <head> has no <Corten />"));
        };
        #[cfg(debug_assertions)]
        if self.shared.dev && !swap {
            unruled_vars(&out, &vars)?;
        }
        // Its 16 hex digits, written once for the head and the header.
        let mut digits = [0; 16];
        let key = crate::ascii::hex(self.key(crate::view::SHELL.get()), &mut digits);
        let mut tags = String::new();
        if swap {
            self.section_links(&mut tags);
            self.swap_preloads(&modules, &mut tags);
        } else {
            tags.reserve(1024 + vars.len());
            self.head_tags(&modules, key, &mut tags);
            // After every stylesheet the page links, so its values win a tie as an inline style would.
            if !vars.is_empty() {
                tags.push_str("<style>");
                tags.push_str(&vars);
                tags.push_str("</style>");
            }
        }
        if !tags.is_empty() {
            out.insert_str(at, &tags);
        }
        // Each place for a layout read, where it is now; filled after the handler answers, or
        // removed now for a page Corten does not fill.
        let mut places = places;
        if !places.slots.is_empty() {
            // A place noted before `</head>` (an expression there renders through a string of its
            // own, so its offset is small) is in the head.
            let head_end = if swap { None } else { out.find("</head>") };
            for slot in &mut places.slots {
                if slot.at >= at {
                    slot.at += tags.len();
                }
            }
            // One rendered through a string of its own is found where its mark is now.
            crate::layout::locate(&out, &mut places);
            for slot in &mut places.slots {
                slot.head = slot.placed && head_end.is_some_and(|end| slot.at < end);
            }
            #[cfg(debug_assertions)]
            self.check_slots(&out, &places, swap)?;
        }
        // Only a place in the page as markup, outside `<head>`, is filled, so only one waits for its read.
        let fills = self.fills && !swap && places.slots.iter().any(|slot| slot.placed && !slot.head);
        if !fills {
            crate::layout::strip(&mut out, &places);
        }
        size.store(out.len() + out.len() / 8, Ordering::Relaxed);
        // Only a swap says it is one: a document a cache gave to a navigation fetch by mistake
        // makes the runtime load the URL in full.
        let mut res = self.finish(html_response(status, out, swap.then_some(PAGE_HEADER), self.vary()), key);
        if fills {
            res.extensions_mut().insert(crate::layout::Pending { places, signal: self.signal.clone() });
            // Looked for only when there is one: a page with places is otherwise every `GET`'s.
            if self.early != 0 {
                if let Some(head) = self.signal.early_head(self.early) {
                    res.extensions_mut().insert(crate::layout::EarlyHead(head));
                }
            }
        }
        if !vars.is_empty() {
            res.extensions_mut().insert(crate::security::StyleBlock(crate::security::hash_source(&vars)));
        }
        // A form's submit key is new on every render, so this body's tag would never match.
        if drawing.drew() {
            self.signal.mark_key_drawn();
            res.extensions_mut().insert(crate::cache::Unrepeatable);
        }
        Ok(HtmlResponse::new(res))
    }

    /// The versioned URL of a static file, named by the constant [`crate::assets::embed!`] made
    /// for it: `req.asset(Static::STYLE_CSS)`. It is written where it is used, with nothing
    /// allocated. A file of a directory the app was not given (`App::assets`) panics in debug
    /// builds; in release the page still renders, with a link that 404s.
    pub fn asset(&self, file: crate::assets::Asset) -> crate::assets::AssetUrl<'_> {
        match &self.shared.assets {
            Some(assets) => assets.asset(file),
            None => no_assets(file.path()),
        }
    }

    /// The versioned URL of the static file at `path`, a name that comes from data (an item's
    /// picture, `cards/item_1.svg`), or `None` when the directory has no such file.
    pub fn find_asset<'a>(&'a self, path: &'a str) -> Option<crate::assets::AssetUrl<'a>> {
        self.shared.assets.as_ref()?.find(path)
    }

    /// True when `href` (a typed route) is the current page, or with `section` any page under
    /// it: the rule the runtime applies to `<a data-nav>` (`data-nav="section"`) after each
    /// navigation. A URL that is not a path on this site (`//host/x`, `/\host/x`, a full or a
    /// relative URL) is never the current page, even at a request path with its text.
    pub fn is_current(&self, href: &(impl crate::route::Href + ?Sized), section: bool) -> bool {
        match href.as_text() {
            Some(text) => is_current(self.uri.path(), text, section),
            None => is_current(self.uri.path(), &crate::route::link(href), section),
        }
    }

    /// A nav link to `to`, from one mention of the route: `<a {..req.nav(&url::About)}>"About"</a>`
    /// writes `href`, `data-nav` (so the runtime keeps `aria-current` right after a client
    /// navigation) and `aria-current="page"` when `to` is this page.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[derive(Route)]
    /// #[route("/news")]
    /// struct News;
    /// #[derive(Route)]
    /// #[route("/about")]
    /// struct About;
    ///
    /// // On /news: <a href="/news" data-nav aria-current="page">News</a><a href="/about" data-nav>About</a>
    /// fn nav(req: &Req) -> String {
    ///     html! { <nav><a {..req.nav(&News)}>"News"</a><a {..req.nav(&About)}>"About"</a></nav> }.to_html()
    /// }
    /// let _: fn(&Req) -> String = nav;
    /// ```
    ///
    /// The tag cannot also write one of those attributes, which the browser would ignore:
    ///
    /// ```compile_fail,E0080
    /// use corten::prelude::*;
    ///
    /// #[derive(Route)]
    /// #[route("/news")]
    /// struct News;
    ///
    /// fn nav(req: &Req) -> String {
    ///     html! { <a href={News} {..req.nav(&News)}>"News"</a> }.to_html()
    /// }
    /// let _: fn(&Req) -> String = nav;
    /// ```
    ///
    /// Nor can a link be marked by hand, which would name its route twice:
    ///
    /// ```compile_fail
    /// use corten::prelude::*;
    ///
    /// #[derive(Route)]
    /// #[route("/news")]
    /// struct News;
    ///
    /// let link = html! { <a href={News} data-nav>"News"</a> };
    /// ```
    pub fn nav<'a, R: crate::Route>(&'a self, to: &'a R) -> Nav<'a, R> {
        Nav { path: self.uri.path(), to, section: false }
    }

    /// [`Req::nav`] for a link to a section: current on any page under `to` too
    /// (`data-nav="section"`), as a nav's "News" stays current on a story's page.
    pub fn nav_section<'a, R: crate::Route>(&'a self, to: &'a R) -> Nav<'a, R> {
        Nav { path: self.uri.path(), to, section: true }
    }

    /// A whole nav's links, for a nav whose entries nest (a section and a page under it) or come
    /// from data: of the entries that hold this page, only the deepest is current. Seller Desk
    /// (`/account/desk`, a section) is current on `/account/desk/repricing`, and only Money
    /// (`/account/desk/money`) on its own page. An entry is a typed route or a [`crate::Local`]
    /// read from data, each with its item (a label, or the row it came from), which
    /// [`NavLinks::links`] hands back with its link. The links name their group (`data-nav-group`),
    /// so the runtime ranks the same links after a client navigation wherever the markup puts
    /// them; a link of [`Req::nav`] or [`Req::nav_section`] is still judged alone. An entry whose
    /// page also answers at another address is current there too with [`NavTo::also`]. Leave out an
    /// entry the user may not see before the call, not in the markup: the runtime ranks only the
    /// links in the page. An entry whose URL is not a path on this site, one `/` and then not `/` or
    /// `\` (`//host/x`, which only a route implemented by hand writes), is never current, on the
    /// server and in the runtime alike; nor, as a syntax restriction rather than a browser's rule, is
    /// one with a tab or a line break straight after its first `/`.
    ///
    /// ```
    /// use corten::prelude::*;
    /// use corten::{NavTo, Local};
    ///
    /// #[derive(Route)]
    /// #[route("/account/desk")]
    /// struct Desk;
    /// #[derive(Route)]
    /// #[route("/account/desk/money")]
    /// struct Money;
    ///
    /// fn nav(req: &Req, help: &Local) -> String {
    ///     let nav = req.nav_of([
    ///         (NavTo::section(&Desk), "Seller Desk"),
    ///         (NavTo::page(&Money), "Money"),
    ///         (NavTo::page(help), "Help"),
    ///     ]);
    ///     html! { <nav>for (link, label) in nav.links() { <a {..link}>{*label}</a> }</nav> }.to_html()
    /// }
    /// let _: fn(&Req, &Local) -> String = nav;
    /// ```
    ///
    /// A URL written as text is not an entry:
    ///
    /// ```compile_fail,E0277
    /// let _ = corten::NavTo::page(&"/account/desk");
    /// ```
    ///
    /// Nor can a link join a group by hand, which the server did not rank:
    ///
    /// ```compile_fail
    /// use corten::prelude::*;
    ///
    /// let link = html! { <a data-nav-group="a">"News"</a> };
    /// ```
    pub fn nav_of<'a, T>(&self, entries: impl IntoIterator<Item = (NavTo<'a>, T)>) -> NavLinks<T> {
        nav_links(self.uri.path(), entries)
    }

    /// Renders `view` once, as the page would (in the visitor's time zone under
    /// [`crate::App::zoned_dates`]), to place in several answers: see [`crate::Rendered`].
    /// One that draws a form's new submit key keeps this request's answer out of shared caches,
    /// as a page whose render drew one is, wherever it is placed.
    pub fn rendered(&self, view: impl Render) -> crate::Rendered {
        #[cfg(feature = "zones")]
        let _zone = self.zone_scope();
        let rendered = crate::Rendered::new(view);
        if rendered.drew_key() {
            self.signal.mark_key_drawn();
        }
        rendered
    }

    /// This request's CSP nonce, for the layout's own inline scripts. Empty without a policy.
    ///
    /// Asking for it makes one and puts it in the CSP, so the page is different bytes on every
    /// request and is never cached for other users (see [`crate::App`], caching). Prefer a
    /// script file from the static directory.
    pub fn nonce(&self) -> &str {
        self.nonce.as_ref().map_or("", |slot| &slot.get().0)
    }

    /// Renders `view` and returns the script modules its handlers use, for the page to load.
    /// In a debug build (a router test, `cargo run`, `corten dev`), a component with a script or
    /// stylesheet the page does not get is an error, since it would be served unstyled or without
    /// its handlers: the app does not list it, or lists it in another area only. Release builds do
    /// not record what renders, so a render does no bookkeeping, and do not check.
    /// `page` is false for a patch, whose hint's control may be on the page already, and whose
    /// submit key with no value the runtime that asked for it fills when the form is sent.
    fn render_into(&self, view: impl Render, out: &mut String, page: bool) -> Result<Vec<&'static str>> {
        #[cfg(feature = "zones")]
        let _zone = self.zone_scope();
        if !cfg!(debug_assertions) {
            // Only a debug build checks the hints `page` is for.
            let _ = page;
            let ((), modules) = crate::script::collect(|| {
                // An empty buffer: to_html sizes it from earlier renders of the same view.
                if out.capacity() == 0 {
                    *out = view.to_html();
                } else {
                    view.render(out);
                }
            });
            return Ok(modules);
        }
        #[cfg(debug_assertions)]
        let start = out.len();
        #[cfg(debug_assertions)]
        let ((((), used), modules), hints) =
            crate::form::collect_hints(|| crate::script::collect(|| crate::style::collect(|| view.render(out))));
        #[cfg(not(debug_assertions))]
        let (((), used), modules) = crate::script::collect(|| crate::style::collect(|| view.render(out)));
        self.check_rendered(&used, page)?;
        #[cfg(debug_assertions)]
        self.check_modules(&modules)?;
        #[cfg(debug_assertions)]
        self.check_hints(&out[start..], &hints, page)?;
        #[cfg(debug_assertions)]
        if page {
            self.check_submit_keys(&out[start..])?;
            if self.at_post {
                self.check_action_forms(&out[start..])?;
            }
        }
        Ok(modules)
    }

    /// In a debug build: an error when a page drawn at one of a page's posts' addresses (`?do=..`:
    /// a write it refused, without JavaScript, or the address opened) has a post form with no
    /// `action`. The browser stays at that address, so the form would send its post to that action
    /// again, whatever it is for. Only a page at such an address is read.
    #[cfg(debug_assertions)]
    #[cold]
    #[inline(never)]
    fn check_action_forms(&self, html: &str) -> Result<()> {
        match post_form_without_action(html) {
            Some(form) => Err(self.unserved(format!(
                "{path} is drawn at one of its posts' addresses (do=..), where the browser stays, and it draws the post form {form} with no action, which would send its post to that address again: write each post form's action, action={{page}} for its post = .. or action={{page.save()}} for a post(save) = ..",
                path = self.path()
            ))),
            None => Ok(()),
        }
    }

    /// In a debug build: an error when the page draws a hint with text (`id={HintId(&id)}`) that
    /// the element `id` does not name in `aria-describedby`, or, in a page, that no element `id`
    /// is drawn for, so a screen reader never reads it.
    #[cfg(debug_assertions)]
    #[cold]
    #[inline(never)]
    fn check_hints(&self, html: &str, hints: &[String], page: bool) -> Result<()> {
        match crate::form::unnamed_hint(html, hints, page) {
            Some(hint) => Err(self.unserved(format!(
                "{path} draws the hint {hint}, which has text, and the element it describes does not name it in aria-describedby (or is not drawn), so a screen reader never reads it: give the control .hint() ({{..e.control(f.x).hint()}}), or e.aria(f.x).hint(&HintId(..)), or aria-describedby={{HintId(..)}} (a corten-ui widget's attrs)",
                path = self.path()
            ))),
            None => Ok(()),
        }
    }

    /// In a debug build: an error when a page draws a submit key with no value
    /// ([`crate::SubmitKey::template_field`]) outside a `<template>` a script copies (a declarative
    /// shadow root, `<template shadowrootmode="open">`, is drawn in the page). The runtime gives it one
    /// when the form is sent, but a browser without JavaScript sends it empty and every post is
    /// refused.
    #[cfg(debug_assertions)]
    #[cold]
    #[inline(never)]
    fn check_submit_keys(&self, html: &str) -> Result<()> {
        match crate::form::keyless_submit_field(html) {
            Some(field) => Err(self.unserved(format!(
                "{path} draws the submit key {field}, which has no value, outside a <template> a script copies, so a browser without JavaScript sends it empty and the post is refused: draw SubmitKey::field(..) in a form the server draws, including one in a declarative shadow root (<template shadowrootmode=\"open\">), which is drawn in the page, and SubmitKey::template_field(..) only in a <template> a script copies",
                path = self.path()
            ))),
            None => Ok(()),
        }
    }

    /// In debug builds (a router test, `cargo run`): an error when the page's handlers call a
    /// script module the app does not serve, which a browser would only find as a 404 and
    /// handlers that do nothing. Release builds do not check a swap; a full page logs it.
    #[cfg(debug_assertions)]
    #[cold]
    #[inline(never)]
    fn check_modules(&self, modules: &[&'static str]) -> Result<()> {
        match modules.iter().find(|name| {
            **name != crate::script::PART_MODULE && !self.shared.assets.as_ref().is_some_and(|a| a.module_tag(name).is_some())
        }) {
            Some(name) => Err(self.unserved(unserved_module(name))),
            None => Ok(()),
        }
    }

    /// A debug build's error for something a page would be served without. It describes the app's
    /// code, not the request, so its message stays on the error page's [`Failure::detail`] outside
    /// `corten dev` too (a router test that prints the body names what to fix), and a router test
    /// has no logger, so it goes to stderr as well.
    #[cold]
    fn unserved(&self, message: String) -> Error {
        unserved(self.shared.dev, message)
    }

    /// In a debug build: the page's places for layout values are each a read the app starts, in
    /// the layout around `<main>`, rendered once as markup. In a release build a place for a read
    /// the app does not start draws nothing (logged once), and one inside `<main>` is removed from
    /// a navigation's page.
    #[cfg(debug_assertions)]
    #[cold]
    #[inline(never)]
    fn check_slots(&self, page: &str, places: &crate::layout::Places, swap: bool) -> Result<()> {
        let slots = &places.slots[..];
        // Each mark once, as markup: one rendered as text (escaped) is not a place, and one whose
        // string the page wrote twice is filled once. (One rendered into a string the page never
        // wrote draws nothing, as it would in a release build.)
        for (index, crate::layout::Slot { name, .. }) in slots.iter().enumerate() {
            let mark = crate::layout::mark(places.token, index);
            let how = match page.matches(&mark).count() {
                0 if page.contains(&crate::html::escape(&mark)[..]) => "as text (escaped), so it is not a place",
                2.. => "more than once from one string",
                _ => continue,
            };
            return Err(self.unserved(format!(
                "the page renders later::<{name}>() {how}: render it as markup, once for each place (later::<{name}>() in html!, not its to_html())"
            )));
        }
        let missing = slots.iter().find(|slot| !self.shared.layout_reads.iter().any(|read| read.id() == slot.id));
        if let Some(crate::layout::Slot { name, .. }) = missing {
            return Err(self.unserved(format!(
                "the page draws later::<{name}>(), a read the app does not start, so nothing is drawn there: add App::layout_read({name}{{..}})"
            )));
        }
        // `<main>` as the layout writes it, in a full page (a navigation's page is `<main>` alone).
        let main = (!swap)
            .then(|| {
                // The first `<main>` tag (not `<main-menu>`) to the `</main>` that closes it.
                let start = page
                    .match_indices("<main")
                    .map(|(at, _)| at)
                    .find(|&at| matches!(page.as_bytes().get(at + 5), Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')))?;
                Some(start..start + page[start..].find("</main>")?)
            })
            .flatten();
        // Each element marked `page` in a full page, from its tag to its closing tag: the first one of
        // its name with as many of its name opened as closed before it.
        let parts: Vec<std::ops::Range<usize>> = if swap {
            Vec::new()
        } else {
            page.match_indices(" data-corten-page")
                .filter_map(|(at, _)| {
                    let start = page[..at].rfind('<')?;
                    let name: String = page[start + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
                    let (open, close) = (format!("<{name}"), format!("</{name}>"));
                    let (mut depth, mut from) = (0usize, at);
                    loop {
                        let end = from + page[from..].find(&close)?;
                        depth += page[from..end]
                            .match_indices(&open)
                            .filter(|(o, _)| {
                                matches!(
                                    page.as_bytes().get(from + o + open.len()),
                                    Some(b'>' | b' ' | b'\t' | b'\n' | b'\r' | b'/')
                                )
                            })
                            .count();
                        if depth == 0 {
                            break Some(start..end);
                        }
                        depth -= 1;
                        from = end + close.len();
                    }
                })
                .collect()
        };
        let inside = |slot: &crate::layout::Slot| {
            swap || slot.head
                || main.as_ref().is_some_and(|main| main.contains(&slot.at))
                || parts.iter().any(|part| part.contains(&slot.at))
        };
        if let Some(crate::layout::Slot { name, .. }) = slots.iter().find(|slot| slot.placed && inside(slot)) {
            return Err(self.unserved(format!(
                "the page draws later::<{name}>() inside <main>, <head> (its <title> included) or an element marked page, which a client navigation sends and does not start the read for: draw it in the <body> around <main>, outside those"
            )));
        }
        Ok(())
    }

    /// In a debug build: an error when the page rendered a component whose script or stylesheet
    /// it does not get, because the app does not list it or lists it in a section the page is
    /// not under. A patch (`page` false) brings the stylesheets of its handler's path wherever it
    /// lands, so its components are checked against that path too. Kept out of
    /// [`Req::render_into`], which is compiled once per view.
    #[cold]
    #[inline(never)]
    fn check_rendered(&self, used: &[&'static crate::Component], page: bool) -> Result<()> {
        if let Some(missing) = used.iter().find(|c| !self.shared.components.contains(c.name)) {
            let what = match (missing.script.is_some(), missing.style.is_some()) {
                (true, true) => "script and stylesheet are",
                (true, false) => "script is",
                _ => "stylesheet is",
            };
            let name = missing.name;
            return Err(self.unserved(if page {
                format!("the page renders {name}, which the app does not list, so its {what} not served: add {name} to App::components")
            } else {
                format!(
                    "the patch renders {name}, which the app does not list, so its {what} not served: add {name} to App::components"
                )
            }));
        }
        for component in used {
            let Some(&index) = self.shared.section_of.get(component.name) else { continue };
            let prefixes = &self.shared.sections[index].0;
            if !prefixes.iter().any(|prefix| crate::api::under(prefix, self.path())) {
                let (path, name, areas) = (self.path(), component.name, prefixes.join(" and the area "));
                return Err(self.unserved(if page {
                    format!(
                        "{path} renders {name}, whose stylesheet is linked from the area {areas} only: list {name} in this page's area too, or route the page in that area"
                    )
                } else {
                    format!(
                        "{path} answers with a patch that renders {name}, whose stylesheet is linked from the area {areas} only, and a patch brings the stylesheets of its handler's area: list {name} in this route's area too, or route the handler in that area"
                    )
                }));
            }
        }
        Ok(())
    }

    /// The `<link>` tags of the section stylesheets for this request's path: in a page's head, a
    /// navigation's answer, or after a patch, whose page may be in another area (the runtime adds
    /// those the page lacks before it puts the patch in place). Nothing in an app whose areas list
    /// no components.
    #[inline]
    fn section_links(&self, out: &mut String) {
        let path = self.uri.path();
        for (prefixes, link) in &self.shared.sections {
            if prefixes.iter().any(|prefix| crate::api::under(prefix, path)) {
                out.push_str(link);
            }
        }
    }

    /// A swapped-in page's preloads: what its handlers' modules import (sibling modules,
    /// `corten/events`, `corten/views`), so the runtime fetches them with the modules, as a full
    /// load's head does, rather than once each module arrives. The modules themselves the runtime
    /// imports. Nothing for a page whose modules import nothing.
    fn swap_preloads(&self, modules: &[&'static str], out: &mut String) {
        part_preload(modules, out);
        let Some(assets) = &self.shared.assets else { return };
        let (mut events, mut views) = (false, false);
        for name in modules {
            let Some((imports, e, v)) = assets.swap_imports(name) else { continue };
            for link in imports {
                if !out.contains(&**link) {
                    out.push_str(link);
                }
            }
            events |= e;
            views |= v;
        }
        if let Some(tag) = assets.events_tag().filter(|_| events) {
            out.push_str(tag);
        }
        if let Some(tag) = assets.views_tag().filter(|_| views) {
            out.push_str(tag);
        }
    }

    /// Adds the shell key, which tells the runtime whether the page around `<main>` is still current.
    /// `res` already varies as [`Req::vary`] says; `key` is the key's 16 hex digits.
    fn finish(&self, mut res: Response, key: &str) -> Response {
        res.headers_mut().insert(SHELL_HEADER, HeaderValue::from_str(key).expect("hex is a valid header"));
        self.content_language(&mut res);
        if let Some(notice) = &self.notice {
            // Shown once: this page is the one it was for, drawn here or by the runtime.
            if matches!(notice.gone, Gone::Host | Gone::Both) {
                res.headers_mut().append(header::SET_COOKIE, crate::security::cookie::SetCookie::remove(NOTICE_COOKIE).header());
            }
            if matches!(notice.gone, Gone::Plain | Gone::Both) {
                let plain = crate::security::cookie::SetCookie::remove(PLAIN_NOTICE_COOKIE).insecure();
                res.headers_mut().append(header::SET_COOKIE, plain.header());
            }
            self.signal.mark_personal();
            if notice.gone == Gone::Sent {
                // Drawn for the request that sent it back: a cache keeps it for that request alone.
                let vary = format!("{}, corten-notice", self.vary().to_str().unwrap_or_default());
                if let Ok(vary) = HeaderValue::from_str(&vary) {
                    res.headers_mut().insert(header::VARY, vary);
                }
            }
            #[cfg(debug_assertions)]
            if matches!(self.mode, Mode::Document) && notice.gone != Gone::Sent && !self.signal.notice_drawn() {
                tracing::warn!(
                    "corten: {} was sent a notice (req.redirect_with_notice) it did not draw (req.notice()), so a full load drops it",
                    self.uri.path()
                );
            }
            // Drawn or not (`&d`): the runtime keeps it across a reload in the page's place, and
            // announces only one the page did not draw. A whole document has it too, for the page
            // the runtime fetches whole after a write; a browser's full load ignores it.
            let mut text = form_urlencoded::Serializer::new(String::new()).append_pair("m", notice.as_str()).finish();
            if self.signal.notice_drawn() {
                text.push_str("&d");
            }
            if let Ok(value) = HeaderValue::from_str(&text) {
                res.headers_mut().insert(NOTICE_HEADER, value);
            }
        }
        res
    }

    /// What the answer varies on. With [`crate::App::messages`] every answer is in the locale
    /// `Accept-Language` asks for (its `Content-Language` says which) unless the handler chose it
    /// from the URL; without, only one that read messages in the language the header asks for is.
    fn vary(&self) -> HeaderValue {
        let language = match self.shared.locales {
            Some(_) => self.signal.locale().is_none(),
            None => self.signal.asked_language(),
        };
        HeaderValue::from_static(if language { VARY_LANGUAGE } else { VARY })
    }

    /// `Content-Language`: the locale the answer is in, in an app with messages.
    fn content_language(&self, res: &mut Response) {
        if self.shared.locales.is_some() {
            let tag = self.lang();
            // The tags `messages!` takes are letters, digits and `-`; another `Messages` may not be.
            if tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                res.headers_mut().insert(header::CONTENT_LANGUAGE, HeaderValue::from_static(tag));
            }
        }
    }

    /// The tags Corten needs in `<head>` after the page's own: script settings, the shell key,
    /// the app's configured tags, section stylesheets, the import map, the runtime and modules.
    fn head_tags(&self, modules: &[&'static str], key: &str, out: &mut String) {
        out.push_str(r#"<meta name="corten-scripts" content=""#);
        out.push_str(&self.shared.scripts_dir);
        out.push_str(r#""><meta name="corten-shell" content=""#);
        out.push_str(key);
        out.push_str(r#"">"#);
        // The page's CSP lets scripts load from other hosts: the `default` Trusted Types policy
        // that lets a script set such a URL, made before any script after it runs.
        if self.nonce.as_ref().is_some_and(|slot| slot.2) {
            out.push_str("<script>");
            out.push_str(crate::security::SCRIPT_LOADS);
            out.push_str("</script>");
        }
        out.push_str(&self.shared.head_extra);
        self.section_links(out);
        out.push_str(r#"<script type="importmap">"#);
        out.push_str(&self.shared.import_map);
        out.push_str(r#"</script><script type="module" src=""#);
        out.push_str(crate::runtime_path());
        out.push_str(r#""></script>"#);
        part_preload(modules, out);
        // The modules the page's handlers call, fetched with the runtime rather than on first use.
        // A component's module hands its exports to the runtime as it runs, so it is a module script
        // of the page: its handlers are in before DOMContentLoaded, with no import() to wait on.
        // Each module's tag was made when the assets loaded.
        if let Some(assets) = &self.shared.assets {
            let mut events = false;
            let mut views = false;
            for name in modules.iter().filter(|name| **name != crate::script::PART_MODULE) {
                let Some((tag, imports_events, imports_views)) = assets.module(name) else {
                    tracing::error!("corten: {}", unserved_module(name));
                    continue;
                };
                out.push_str(tag);
                events |= imports_events;
                views |= imports_views;
            }
            // A handler module that imports the views (corten/views) has them fetched with it.
            if let Some(tag) = assets.views_tag().filter(|_| views) {
                out.push_str(tag);
            }
            // And one that imports the typed events (corten/events) has them fetched with it.
            if let Some(tag) = assets.events_tag().filter(|_| events) {
                out.push_str(tag);
            }
        }
    }

    /// [`Req::page`] for a page other clients read too: a browser gets HTML as usual, and a
    /// [`Mode::Data`] request gets `{"title": ..., "data": data}`, the title being the text of the
    /// document's `<title>`. `data` is the screen's view model, so a native screen or an agent sees
    /// exactly what the view shows; for it, only the document's `<title>` renders.
    ///
    /// Its answer is any `HtmlResult`, or the `HtmlResult<Screen<T>>` of a route that says
    /// `data = T` ([`crate::Screen`]), whose URL a page's script can read the data from, typed
    /// (`read()` from `corten/read`, [Scripts](https://github.com/corten-run/corten/blob/main/docs/guide/scripts.md#a-screens-data)):
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// pub mod url {
    ///     #[route("/sets/{set}", get = set, data = SetListing)]
    ///     pub struct Set<'a> {
    ///         pub set: &'a str,
    ///     }
    /// }
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing {
    ///     name: String,
    ///     products: Vec<String>,
    /// }
    ///
    /// async fn set(req: Req, Params(at): Params<url::Set<'_>>) -> HtmlResult<corten::Screen<SetListing>> {
    ///     let listing = SetListing { name: at.set.to_string(), products: Vec::new() };
    ///     let name = &listing.name;
    ///     req.screen(&listing, html! { <html><head><title>{name}</title><Corten /></head><body><main>{name}</main></body></html> })
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    ///
    /// A page, a redirect or a screen of other data is not the route's data, so none compiles
    /// there:
    ///
    /// ```compile_fail,E0308
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// async fn set(req: Req) -> HtmlResult<corten::Screen<SetListing>> {
    ///     req.page(html! { <html><head><title>"Set"</title><Corten /></head><body><main>"Set"</main></body></html> })
    /// }
    /// ```
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    /// #[derive(ToJson)]
    /// pub struct Order { id: String }
    ///
    /// async fn set(req: Req) -> HtmlResult<corten::Screen<SetListing>> {
    ///     let order = Order { id: "7".into() };
    ///     req.screen(&order, html! { <html><head><title>"Order"</title><Corten /></head><body><main>"7"</main></body></html> })
    /// }
    /// ```
    ///
    /// The route checks its `get` handler at its name, so one that may answer without the data
    /// does not compile where the route says `data`:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// pub mod url {
    ///     #[route("/sets", get = sets, data = SetListing)]
    ///     pub struct Sets;
    /// }
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// async fn sets(req: Req) -> HtmlResult {
    ///     let listing = SetListing { name: "All".into() };
    ///     req.screen(&listing, html! { <html><head><title>"Sets"</title><Corten /></head><body><main>"Sets"</main></body></html> })
    /// }
    /// # fn main() { let _ = url::router(); }
    /// ```
    ///
    /// The data may be the value, a reference to it, or a `Box`, `Rc` or `Arc` of it, whose JSON
    /// is the value's (`req.screen(&listing, ..)` with `listing: &SetListing` or
    /// `Arc<SetListing>`). The answer's kind is read from where it goes, as a patch's is: a
    /// handler's return type, or a `Public` it is given to there.
    ///
    /// ```
    /// use std::{sync::Arc, time::Duration};
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// fn set_page(name: &str) -> impl Document + '_ {
    ///     html! { <html><head><title>{name}</title><Corten /></head><body><main>{name}</main></body></html> }
    /// }
    ///
    /// async fn shared(req: Req, listing: Arc<SetListing>) -> HtmlResult<corten::Screen<SetListing>> {
    ///     req.screen(&listing, set_page(&listing.name))
    /// }
    ///
    /// async fn borrowed(req: &Req, listing: &SetListing) -> HtmlResult<corten::Screen<SetListing>> {
    ///     req.screen(&listing, set_page(&listing.name))
    /// }
    ///
    /// async fn public(req: Req) -> Public<HtmlResult> {
    ///     let listing = SetListing { name: "All".into() };
    ///     Public::new(Duration::from_secs(60), req.screen(&listing, set_page(&listing.name)))
    /// }
    /// ```
    ///
    /// Where nothing says it (a closure that returns `Public::new(..)`), the call names it:
    ///
    /// ```compile_fail,E0283
    /// use std::time::Duration;
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// let set = |req: Req| async move {
    ///     let listing = SetListing { name: "All".into() };
    ///     Public::new(Duration::from_secs(60), req.screen(&listing, html! { <html><head><title>"All"</title><Corten /></head><body><main>"All"</main></body></html> }))
    /// };
    /// # let _ = get(set);
    /// ```
    ///
    /// ```
    /// use std::time::Duration;
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// let set = |req: Req| async move {
    ///     let listing = SetListing { name: "All".into() };
    ///     Public::new(
    ///         Duration::from_secs(60),
    ///         req.screen::<_, corten::AnyAnswer, _>(&listing, html! { <html><head><title>"All"</title><Corten /></head><body><main>"All"</main></body></html> }),
    ///     )
    /// };
    /// # let _: corten::Methods = get(set);
    /// ```
    ///
    /// Nor does `NoStore::new(..)` in a closure:
    ///
    /// ```compile_fail,E0283
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// let set = |req: Req| async move {
    ///     let listing = SetListing { name: "All".into() };
    ///     NoStore::new(req.screen(&listing, html! { <html><head><title>"All"</title><Corten /></head><body><main>"All"</main></body></html> }))
    /// };
    /// # let _ = get(set);
    /// ```
    ///
    /// and names the kind the same way:
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[derive(ToJson)]
    /// pub struct SetListing { name: String }
    ///
    /// let set = |req: Req| async move {
    ///     let listing = SetListing { name: "All".into() };
    ///     NoStore::new(
    ///         req.screen::<_, corten::AnyAnswer, _>(&listing, html! { <html><head><title>"All"</title><Corten /></head><body><main>"All"</main></body></html> }),
    ///     )
    /// };
    /// # let _: corten::Methods = get(set);
    /// ```
    #[cfg(feature = "json")]
    pub fn screen<For, Kind: crate::answer::ScreenKind<T>, T: crate::json::ToJson + ?Sized>(
        &self,
        data: &T,
        doc: impl Document,
    ) -> crate::Result<HtmlResponse<For, Kind>> {
        self.screen_with_status(StatusCode::OK, data, doc)
    }

    /// [`Req::screen`] with another status.
    #[cfg(feature = "json")]
    pub fn screen_with_status<For, Kind: crate::answer::ScreenKind<T>, T: crate::json::ToJson + ?Sized>(
        &self,
        status: StatusCode,
        data: &T,
        doc: impl Document,
    ) -> crate::Result<HtmlResponse<For, Kind>> {
        if self.mode != Mode::Data {
            return self.page_as(status, doc);
        }
        use crate::json::ToJson;
        let mut title = String::new();
        doc.render_part(&mut title, Part::Title);
        // `{"title":...,"data":...}`, as serde_json writes the pair.
        let mut body = Vec::with_capacity(T::__json_size().map_or(128, |s| s.load(std::sync::atomic::Ordering::Relaxed) + 64));
        body.extend_from_slice(br#"{"title":"#);
        crate::html::unescape(&title).as_ref().write_json(&mut body);
        body.extend_from_slice(br#","data":"#);
        data.write_json(&mut body);
        body.push(b'}');
        let headers = [(header::CONTENT_TYPE, HeaderValue::from_static("application/json")), (header::VARY, self.vary())];
        let mut res = (status, headers, body).into_response();
        self.content_language(&mut res);
        Ok(HtmlResponse::new(res))
    }

    /// In a debug build: the patch `body`, as sent, is one the browser keeps whole when the runtime
    /// parses it as a `<template>`'s content (`crate::html::patch_parse`): a table part
    /// beside other elements can be dropped or moved there, which the compiler does not see when a
    /// component or an expression writes it. A release build sends it as it is.
    #[cfg(debug_assertions)]
    fn parses_whole(&self, body: &str) -> Result<()> {
        match crate::html::patch_parse_checked(body, &format_args!("the patch for {}", self.path())) {
            Some(problem) => {
                Err(self
                    .unserved(format!("the browser would lose part of this patch: {problem}. {}", crate::html::PATCH_PARSE_HELP)))
            }
            None => Ok(()),
        }
    }

    /// The builder for an HTML patch, only when the effective mode is [`Mode::Action`].
    /// Otherwise answer with a page or redirect, or use [`Req::patch_or`] to select both.
    /// This reads `mode`, including an application override; it is not a check for POST.
    #[inline]
    pub fn action(&self) -> Option<Action<'_>> {
        (self.mode == Mode::Action).then_some(Action(self))
    }

    /// Answers a `data-patch` form (a write, Load more) both ways: with JavaScript
    /// ([`Mode::Action`]) `view` as a patch; otherwise `page()`, the whole page or a redirect, so
    /// the form works without JavaScript too. `page` only runs then, so an action never loads
    /// data for a page it does not send. A data client ([`Mode::Data`]) gets `page()` as well. A
    /// submit refused for its input is [`Req::invalid`] (or [`Req::invalid_with`] when the form needs
    /// a read); a patch that needs a read, a status or headers of its own is
    /// [`Req::patch_or_with`], whose part side builds it only for the runtime's request.
    ///
    /// Its answer is a patch whenever the runtime asked, so it is the `HtmlResult<Patches>` of a
    /// route that says `patches` ([`crate::Patches`]) as well as any `HtmlResult`; `page()` is a
    /// plain `HtmlResult`, a page or a redirect.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home, post = greet)]
    ///     pub struct Home;
    /// }
    ///
    /// #[derive(Id)]
    /// struct GreetingId;
    ///
    /// #[component]
    /// fn Greeting<'a>(name: &'a str) -> impl Patch {
    ///     html! { <p id={GreetingId}>"Hello, "{name}</p> }
    /// }
    ///
    /// # async fn home(req: Req) -> HtmlResult { req.redirect(&url::Home) }
    /// async fn greet(req: Req) -> HtmlResult {
    ///     req.patch_or(Greeting { name: "Ada" }, || async { req.redirect(&url::Home) }).await
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    pub fn patch_or<For, Kind: crate::answer::PatchingKind, F, Fut>(
        &self,
        view: impl crate::view::Patch,
        page: F,
    ) -> impl Future<Output = crate::Result<HtmlResponse<For, Kind>>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = crate::Result<HtmlResponse<For>>>,
    {
        // The patch is rendered before the future is made, so the future holds the answer and not
        // `view`: a view of non-`Send` references would make the handler's future not `Send`.
        let patch = self.action().map(|action| action.patch(view));
        async move {
            match patch {
                Some(patch) => patch,
                None => page().await.map(HtmlResponse::of),
            }
        }
    }

    /// [`Req::patch_or`] for a part that needs a read of its own: both sides are lazy, so the
    /// runtime's read of the part ([`Mode::Action`]) runs `part(action)` alone, and every other request
    /// (a full load, a navigation, a data client, a browser without JavaScript) runs `page()`
    /// alone. Neither reads what the other draws. `part(action)` receives the checked
    /// [`Action`] and answers `HtmlResult<Patches>`, which only [`Action::patch`] and the
    /// other methods that answer a patch make, so a page or a redirect there
    /// does not compile; `page()` is a plain `HtmlResult`.
    ///
    /// It is how one handler answers a page and its slow part: the page draws the part waiting,
    /// with [`ReadAgain::now`] inside it, and the runtime reads the part from the page's own route
    /// as soon as the page is on the screen. The route says `patches`
    /// ([`crate::Patches`]). Without JavaScript nothing reads the part, so the waiting part links
    /// to the page with it read in, a field of the page's route that `page()` reads it for
    /// (`docs/design.md#choice-slow-part-link`). Both sides are one route's answers, for the
    /// same people: a page in a [`crate::Public`], which shared caches give to anyone, cannot
    /// read a part for one visitor here, so such a part is read from a route of its own (one that
    /// says `patches`, named by [`ReadAgain::now`]). The page side receives no builder:
    /// it answers the full page or a redirect, not an unchecked patch.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// mod url {
    ///     /// `picks` reads them in, for the link a browser without JavaScript follows.
    ///     #[route("/", get = home, patches)]
    ///     #[derive(Default)]
    ///     pub struct Home {
    ///         pub picks: Option<bool>,
    ///     }
    /// }
    ///
    /// #[derive(Id)]
    /// struct PicksId;
    ///
    /// #[component]
    /// fn Picks<'a>(picks: &'a [String]) -> impl Patch {
    ///     html! { <ul id={PicksId}> for pick in picks { <li>{pick}</li> } </ul> }
    /// }
    ///
    /// /// The slow read.
    /// async fn picks_for_you() -> Vec<String> {
    ///     vec!["Acme".to_string()]
    /// }
    ///
    /// async fn home(req: Req, Params(at): Params<url::Home>) -> HtmlResult<Patches> {
    ///     req.patch_or_with(
    ///         |action| async move { action.patch(Picks { picks: &picks_for_you().await }) },
    ///         || async {
    ///             let picks = if at.picks == Some(true) { Some(picks_for_you().await) } else { None };
    ///             req.page(html! {
    ///                 <html><head><title>"Home"</title><Corten /></head><body><main>
    ///                     if let Some(picks) = &picks {
    ///                         <Picks picks={picks} />
    ///                     } else {
    ///                         <p id={PicksId}>
    ///                             "Finding picks..."
    ///                             <a href={url::Home { picks: Some(true) }} rel="nofollow">"Show picks"</a>
    ///                             {ReadAgain::now(url::Home::default())}
    ///                         </p>
    ///                     }
    ///                 </main></body></html>
    ///             })
    ///         },
    ///     )
    ///     .await
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    ///
    /// A shared answer keeps its inference: `Public` finds `HtmlResult<Patches>` from the call.
    ///
    /// ```
    /// use corten::prelude::*;
    /// use std::time::Duration;
    ///
    /// #[derive(Id)]
    /// struct PartId;
    ///
    /// async fn shared(req: Req) -> Public<HtmlResult<Patches>> {
    ///     Public::new(
    ///         Duration::from_secs(60),
    ///         req.patch_or_with(
    ///             |action| async move { action.patch(html! { <p id={PartId}>"part"</p> }) },
    ///             || async {
    ///                 req.page(html! {
    ///                     <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html>
    ///                 })
    ///             },
    ///         )
    ///         .await,
    ///     )
    /// }
    /// ```
    ///
    /// The part side answers the runtime's read, so a page there does not compile:
    ///
    /// ```compile_fail,E0271
    /// use corten::prelude::*;
    ///
    /// async fn home(req: Req) -> HtmlResult<Patches> {
    ///     let doc = || html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> };
    ///     req.patch_or_with(|_action| async { req.page(doc()) }, || async { req.page(doc()) }).await
    /// }
    /// ```
    /// As with `patch_or`, only patch-answer kinds are possible, not a data screen:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    /// async fn wrong(req: Req) -> HtmlResult<corten::Screen<()>> {
    ///     req.patch_or_with(
    ///         |action| async move { action.patch(html! {}) },
    ///         || async { req.page(html! {
    ///             <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html>
    ///         }) },
    ///     ).await
    /// }
    /// ```
    ///
    /// The part closure takes the checked builder, even if it answers another patch-making method:
    ///
    /// ```compile_fail,E0593
    /// use corten::prelude::*;
    /// async fn wrong(req: Req) -> HtmlResult<Patches> {
    ///     req.patch_or_with(|| async { Err(corten::Error::not_found()) }, || async {
    ///         req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> })
    ///     }).await
    /// }
    /// ```
    pub async fn patch_or_with<'r, For, Kind: crate::answer::PatchingKind, P, PartFut, G, PageFut>(
        &'r self,
        part: P,
        page: G,
    ) -> crate::Result<HtmlResponse<For, Kind>>
    where
        P: FnOnce(Action<'r>) -> PartFut,
        PartFut: Future<Output = crate::Result<HtmlResponse<For, crate::Patches>>>,
        G: FnOnce() -> PageFut,
        PageFut: Future<Output = crate::Result<HtmlResponse<For>>>,
    {
        if let Some(action) = self.action() {
            part(action).await.map(HtmlResponse::of)
        } else {
            page().await.map(HtmlResponse::of)
        }
    }

    /// Answers a refused submit: its input failed validation (422 Unprocessable Content), it was
    /// made against a state that has moved on or while other work on it is under way
    /// ([`Errors::refuse`](crate::Errors::refuse), 409 for a stale revision or a busy lock, 410 for
    /// a deleted record), or a service the handler calls failed (502),
    /// with the status of [`Errors::refusal`](crate::Errors::refusal):
    ///
    /// - [`Mode::Action`]: `form`, the form re-rendered with the errors, as a patch. The runtime
    ///   then moves focus to the first field marked `aria-invalid="true"`.
    /// - [`Mode::Data`] (feature `json`): the Problem Details document with the fields,
    ///   `{"title": "Unprocessable Entity", "status": 422, "detail": "email: ...", "fields": {"email": "..."}}`.
    /// - Otherwise (no JavaScript): `page()`, usually `req.page(..)` for the whole page with the
    ///   form showing the errors; a success status becomes the refusal's. It is only called here,
    ///   so an action never loads data for a page it does not send. Draw the page, never redirect:
    ///   a redirect drops the message and what the user typed.
    ///
    /// The runtime moves focus to the first invalid field only for a 422; a refusal's message is a
    /// `role="alert"` that is announced where it lands.
    ///
    /// As [`Req::patch_or`], its answer may be an `HtmlResult<Patches>` ([`crate::Patches`]).
    pub async fn invalid<For, Kind: crate::answer::PatchingKind, F, Fut>(
        &self,
        errors: &crate::Errors,
        form: impl crate::view::Patch,
        page: F,
    ) -> crate::Result<HtmlResponse<For, Kind>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = crate::Result<HtmlResponse<For>>>,
    {
        let status = errors.refusal().status();
        match self.mode {
            Mode::Action => Action(self).patch_with_status(status, form),
            #[cfg(feature = "json")]
            Mode::Data => Ok(HtmlResponse::new(errors.response())),
            _ => {
                let mut res = page().await?;
                if res.status().is_success() {
                    *res.status_mut() = status;
                }
                Ok(res.of())
            }
        }
    }

    /// [`Req::invalid`] for a refusal whose form needs a read of its own (the record as it is
    /// now): both sides are drawn only for the mode that sends them, so a browser without
    /// JavaScript reads nothing for a patch it never gets, and the patch reads nothing for the
    /// page. `form` gets a [`FormPatch`], which draws the patch and nothing else, so a page or a
    /// redirect on that side does not compile; a data client gets the Problem Details document,
    /// as from `invalid` (feature `json`; without it, the page), and neither side runs. A form drawn from what the handler already has is
    /// `invalid`.
    ///
    /// ```
    /// use corten::{prelude::*, Refusal};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/batch", get = show, post = price)]
    ///     pub struct Batch;
    /// }
    ///
    /// #[derive(Id)]
    /// struct PanelId;
    ///
    /// #[component]
    /// fn Panel<'a>(status: &'a str) -> impl Patch {
    ///     html! { <p id={PanelId}>{status}</p> }
    /// }
    ///
    /// async fn status_now() -> String {
    ///     "Publishing".to_string()
    /// }
    ///
    /// # async fn show(req: Req) -> HtmlResult { req.redirect(&url::Batch) }
    /// async fn price(req: Req) -> HtmlResult {
    ///     let mut errors = Errors::new();
    ///     errors.refuse(Refusal::Conflict, "The batch moved on; here it is now.");
    ///     req.invalid_with(
    ///         &errors,
    ///         |form| async move {
    ///             let status = status_now().await;
    ///             form.draw(Panel { status: &status })
    ///         },
    ///         || async { req.page(html! { <html><head><title>"Batch"</title><Corten /></head><body><main>"Batch"</main></body></html> }) },
    ///     )
    ///     .await
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    ///
    /// The form side draws a patch, so it cannot answer a page:
    ///
    /// ```compile_fail
    /// use corten::prelude::*;
    ///
    /// async fn price(req: Req, errors: Errors) -> HtmlResult {
    ///     req.invalid_with(&errors, |_form| async { req.redirect(&corten::Local::parse("/").unwrap()) }, || async { req.redirect(&corten::Local::parse("/").unwrap()) }).await
    /// }
    /// ```
    pub async fn invalid_with<'r, For, Kind: crate::answer::PatchingKind, F, FormFut, P, PageFut>(
        &'r self,
        errors: &crate::Errors,
        form: F,
        page: P,
    ) -> crate::Result<HtmlResponse<For, Kind>>
    where
        F: FnOnce(FormPatch<'r>) -> FormFut,
        FormFut: Future<Output = crate::Result<DrawnPatch>>,
        P: FnOnce() -> PageFut,
        PageFut: Future<Output = crate::Result<HtmlResponse<For>>>,
    {
        let status = errors.refusal().status();
        match self.mode {
            Mode::Action => {
                let DrawnPatch(body) = form(FormPatch(self)).await?;
                Ok(HtmlResponse::new(html_response(status, body, Some(PATCH_HEADER), HeaderValue::from_static(VARY))))
            }
            #[cfg(feature = "json")]
            Mode::Data => Ok(HtmlResponse::new(errors.response())),
            _ => {
                let mut res = page().await?;
                if res.status().is_success() {
                    *res.status_mut() = status;
                }
                Ok(res.of())
            }
        }
    }

    /// After a successful write, send the browser to `to` (post/redirect/get): a typed route, a
    /// place on its page (`route.at(RowId(&id))`, so the browser comes back to the element the
    /// user acted on), a return address checked to be on this site ([`crate::Local`]), or an
    /// `corten::http::Uri` to leave the app. Works with and without
    /// JavaScript.
    pub fn redirect<For>(&self, to: &(impl crate::route::Href + ?Sized)) -> crate::Result<HtmlResponse<For>> {
        let value = crate::route::header_value(to).map_err(Error::corten)?;
        Ok(HtmlResponse::new(redirect(self.mode, self.fetched, value)))
    }

    /// Send the same form to `to`, whose handler answers it: `307 Temporary Redirect`, which the
    /// browser follows with the same method and body, presenting a cookie this answer sets
    /// (`.with_cookie(..)`). With JavaScript a `data-patch` form's request is followed the same
    /// way, and `to`'s answer (a patch, a redirect) is drawn as this one's would be. For a write
    /// that must first give the browser what the write needs it to present (a guest's session,
    /// so every write runs as someone the request named and a lost answer writes nothing), or
    /// that hands the form to the handler that takes it. Works with and without JavaScript.
    ///
    /// `to` gets the form as it was sent, its [`crate::SubmitKey`] too, so this handler must not
    /// keep that key as used. A browser follows at most about 20 redirects in a row: a handler
    /// that sends the form back to itself marks the address (a parameter of its route) and
    /// answers otherwise when it comes back, in case the browser kept no cookie.
    ///
    /// Only for a write: on a `GET` or `HEAD`, which [`Req::redirect`] already repeats, it is an
    /// error that says so. Only to a page of the app ([`crate::OnSite`]): a form's body is never
    /// sent to another site, a URL of one does not compile, and an address that is not a path on
    /// this site (one a hand-written [`crate::Route`]'s `write_href` writes) is an error.
    ///
    /// ```
    /// use corten::{prelude::*, security::cookie::SetCookie};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/cart", get = cart, post = start)]
    ///     pub struct Cart;
    ///
    ///     #[route("/cart/as-guest", post = start_as_guest)]
    ///     pub struct AsGuest;
    /// }
    ///
    /// # async fn cart(req: Req) -> HtmlResult { req.page(html! { <html><head><title>"Cart"</title><Corten /></head><body><main>"Cart"</main></body></html> }) }
    /// #[derive(serde::Deserialize)]
    /// struct Start {
    ///     item: String,
    /// }
    ///
    /// async fn start(req: Req, Form(_start): Form<Start>) -> HtmlResult {
    ///     // No session yet: start a guest's, and send the same form on with it.
    ///     let guest = "0123456789abcdef";
    ///     Ok(req.resend_to(&url::AsGuest)?.with_cookie(SetCookie::new("guest", guest)))
    /// }
    ///
    /// async fn start_as_guest(req: Req, Form(start): Form<Start>) -> HtmlResult {
    ///     // The guest's cookie is on this request: write as the guest.
    ///     let _ = start.item;
    ///     req.redirect(&url::Cart)
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// async fn pay(req: Req) -> HtmlResult {
    ///     let to: corten::http::Uri = "https://pay.example/checkout".parse().unwrap();
    ///     req.resend_to(&to)
    /// }
    /// ```
    pub fn resend_to<For>(&self, to: &(impl crate::route::OnSite + ?Sized)) -> crate::Result<HtmlResponse<For>> {
        if !self.write {
            return Err(Error::corten(
                "corten: Req::resend_to sends a write's form on, and this request is a GET or HEAD, which a redirect repeats as it is: use req.redirect",
            ));
        }
        let value = crate::route::header_value(to).map_err(Error::corten)?;
        // A derived route always writes a path on this site; a hand-written `write_href` might not:
        // never send a form's body elsewhere.
        if !on_site(&value) {
            return Err(Error::corten(
                "corten: Req::resend_to sends a form only to a path on this site, and this address is not one (a hand-written Route's write_href that does not start with one /, or writes a \\ or a control character)",
            ));
        }
        Ok(HtmlResponse::new((StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, value)]).into_response()))
    }

    /// [`Req::redirect`] with what the write did, said once on the page it lands on ("Batch 3517
    /// deleted."), where [`Req::notice`] reads it: no field on the route carries it, so a reload,
    /// a copied link or Back to a page the browser asks for again does not say it again. It rides in a short-lived cookie for that
    /// page's path (`__Host-corten-notice`, a minute; `corten-notice` for a write from a plain
    /// `http://` origin that is not loopback, which refuses a `Secure` cookie), which the page's
    /// answer removes. A
    /// `data-patch` write's redirect is followed by the whole page, whose layout draws it as a full
    /// load does; a page that did not draw it (a plain navigation's, whose layout around `<main>`
    /// does not run) hands it to the runtime, which dispatches `corten:notice` on the document for
    /// the app's toaster. Text past 500 bytes is cut at a character's end.
    ///
    /// Only for a page of the app ([`crate::OnSite`]: a route, a place on one, a checked
    /// [`crate::Local`], a `#[derive(Href)]` enum of those): a URL of another site does not compile.
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// async fn pay(req: Req) -> HtmlResult {
    ///     let to: corten::http::Uri = "https://pay.example/checkout".parse().unwrap();
    ///     req.redirect_with_notice(&to, "Sent to payment.")
    /// }
    /// ```
    ///
    /// A `#[derive(Href)]` enum is a page of the app when each of its variants is:
    ///
    /// ```
    /// use corten::{prelude::*, Href};
    ///
    /// #[derive(Route)] #[route("/inventory")] struct Inventory;
    /// #[derive(Route)] #[route("/pull-sheet/{id}")] struct PullSheet<'a> { id: &'a str }
    ///
    /// #[derive(Href)]
    /// enum Back<'a> { Inventory(Inventory), PullSheet(PullSheet<'a>) }
    ///
    /// async fn delete(req: Req) -> HtmlResult {
    ///     req.redirect_with_notice(&Back::PullSheet(PullSheet { id: "7" }), "Batch 3517 deleted.")
    /// }
    /// ```
    ///
    /// and not when one of them may go to another site:
    ///
    /// ```compile_fail,E0277
    /// use corten::{prelude::*, Elsewhere, Href};
    ///
    /// #[derive(Route)] #[route("/inventory")] struct Inventory;
    ///
    /// #[derive(Href)]
    /// enum Back<'a> { Inventory(Inventory), Payment(Elsewhere<'a>) }
    ///
    /// async fn delete(req: Req) -> HtmlResult {
    ///     req.redirect_with_notice(&Back::Inventory(Inventory), "Batch 3517 deleted.")
    /// }
    /// ```
    pub fn redirect_with_notice(&self, to: &(impl crate::route::OnSite + ?Sized), notice: impl std::fmt::Display) -> HtmlResult {
        let value = crate::route::header_value(to).map_err(Error::corten)?;
        // A derived route always writes a path on this site; a hand-written `write_href` might not.
        if !on_site(&value) {
            return Err(Error::corten(
                "corten: Req::redirect_with_notice sends the browser only to a path on this site, and this address is not one (a hand-written Route's write_href that does not start with one /, or writes a \\ or a control character)",
            ));
        }
        let link = value.to_str().unwrap_or_default();
        let path = link.split(['?', '#']).next().unwrap_or_default();
        let mut text = notice.to_string();
        if text.len() > NOTICE_MAX {
            let mut end = NOTICE_MAX;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        let cookie =
            form_urlencoded::Serializer::new(String::new()).append_pair("p", &path_key(path)).append_pair("m", &text).finish();
        // Form encoding writes only letters, digits, `*-._+%&=`: all a cookie can carry.
        let cookie = if self.plain_write {
            crate::security::cookie::SetCookie::new(PLAIN_NOTICE_COOKIE, &cookie).insecure()
        } else {
            crate::security::cookie::SetCookie::new(NOTICE_COOKIE, &cookie)
        };
        let cookie = cookie.max_age(60);
        Ok(HtmlResponse::new(redirect(self.mode, self.fetched, value)).with_cookie(cookie))
    }

    /// The notice the write that redirected here left for this page ([`Req::redirect_with_notice`]),
    /// once: the answer removes it. Draw it where the app says what an action did, the layout's
    /// toaster (`Toast { message: req.notice(), failed: false }`) or a status line. A page that has one is
    /// private, as one for a signed-in caller is. When the page that drew it reads itself again
    /// (`ReadAgain`), the runtime sends it back and this answers it for that read too, so the read
    /// draws the page as it is on screen.
    pub fn notice(&self) -> Option<&Notice> {
        let notice = self.notice.as_ref()?;
        self.signal.mark_personal();
        Some(notice)
    }

    /// Whether a redirect to `to` lands on a route of the app's: the route given to
    /// [`crate::App::new`] or to an area that the router picks for its path (the most specific,
    /// as the router picks it) has a `GET` handler. A return address the app does not serve (a page of
    /// another app of the product, or none) goes elsewhere; one it serves is `req.redirect(&to)`.
    /// A form's write sent to another origin needs that origin in the form's page's `form-action`
    /// ([`crate::security::Policy::form_action`]), or the browser stops it.
    /// A route that only takes writes, a path under an API and Corten's own paths are not served.
    /// It does not look at who is asking: a page an area's caller check refuses still counts, and
    /// a record that is not there is still a 404.
    ///
    /// ```
    /// use corten::{prelude::*, Local};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home)]
    ///     pub struct Home;
    ///
    ///     #[route("/sign-in", post = sign_in)]
    ///     pub struct SignIn;
    /// }
    ///
    /// # async fn home(req: Req) -> HtmlResult { req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main>"Home"</main></body></html> }) }
    /// #[derive(serde::Deserialize)]
    /// struct Credentials { next: Option<String> }
    ///
    /// async fn sign_in(req: Req, Form(form): Form<Credentials>) -> HtmlResult {
    ///     // .. start the session ..
    ///     match form.next.as_deref().and_then(Local::parse) {
    ///         Some(next) if req.serves(&next) => req.redirect(&next),
    ///         _ => req.redirect(&url::Home),
    ///     }
    /// }
    /// # let _ = App::new(url::router()).router();
    /// ```
    pub fn serves(&self, to: &crate::Local) -> bool {
        let path = to.path();
        !self.shared.not_pages.contains(path) && crate::route::chosen(&self.shared.pages, path).is_some_and(|(_, get)| get)
    }

    /// The page is at `to` for good (an item asked for by its id or an old slug, a renamed
    /// category): `301 Moved Permanently`, so search engines move the old URL's place to `to` and
    /// the browser keeps the redirect for a day (privately; a shared cache does not), skipping the
    /// round trip next time. A client navigation follows it and puts `to` in the address; a
    /// `data-patch` form is sent there as by [`Req::redirect`]. For a `GET`: after a write,
    /// [`Req::redirect`]. Parameters the old URL had are the route's to carry
    /// (`#[route(prefix = ..)]` for ones named by data), so only the ones it knows move with it.
    pub fn moved<For>(&self, to: &(impl crate::route::Href + ?Sized)) -> crate::Result<HtmlResponse<For>> {
        let value = crate::route::header_value(to).map_err(Error::corten)?;
        if self.mode == Mode::Action || (self.fetched && (has_fragment(&value) || elsewhere(&value))) {
            return Ok(HtmlResponse::new(redirect(self.mode, self.fetched, value)));
        }
        let headers = [
            (header::LOCATION, value),
            (header::CACHE_CONTROL, HeaderValue::from_static(MOVED_CACHE)),
            (header::VARY, HeaderValue::from_static(MODE_VARY)),
        ];
        Ok(HtmlResponse::new((StatusCode::MOVED_PERMANENTLY, headers).into_response()))
    }
}

/// Whether `query` has the key that names one of a page's posts (`do=..`).
#[cfg(debug_assertions)]
fn at_action(query: Option<&str>) -> bool {
    !matches!(crate::router::named(query), crate::router::Named::None)
}

/// The first `<form method="post">` in `html` with no `action` (or an empty one), as written: it
/// posts to the address the page is at.
#[cfg(debug_assertions)]
fn post_form_without_action(html: &str) -> Option<&str> {
    crate::html::start_tags_no_script(html)
        .find(|tag| {
            tag.name == "form"
                && tag.attr("method").is_some_and(|method| method.eq_ignore_ascii_case("post"))
                && tag.attr("action").is_none_or(|action| action.trim().is_empty())
        })
        .map(|tag| &html[tag.start..tag.end])
}

/// A page with a `Refresh` header: browsers keep a full load's after the runtime navigates
/// away, then load that URL again (Chromium, Firefox, WebKit). [`ReadAgain`] is the way.
#[cfg(debug_assertions)]
fn refresh_header_is_an_error(res: Response, dev: bool) -> Response {
    if !(res.headers().contains_key(SHELL_HEADER) && res.headers().contains_key("refresh")) {
        return res;
    }
    let error = unserved(
        dev,
        "this page sends a Refresh header, which the browser keeps after the runtime navigates away and then loads this URL again: put <ReadAgain after={..} /> in the page's head tags instead".to_owned(),
    )
    .into_response();
    crate::cache::unshared_in_place_of(res.extensions(), error)
}

/// A page answering a browser's post, with a success status, at a path whose route has no `GET`
/// handler: the browser shows it at that address, which answers 405 when it is opened again
/// from a bookmark or a link. A form that belongs to one page posts to that page's route; a write
/// with a path of its own redirects once it is done and draws a page only to refuse. The handler's
/// cookies and `Clear-Site-Data` go out with the error page, as the browser would have acted on them
/// with the page; the page's other headers describe the page the error replaces and do not.
///
/// What it does not see: it reads the routes `#[corten::routes]` declares (`route::chosen` on
/// `Shared::pages`), so a hand-built `Table` router's paths are not checked, and a page a
/// hand-built route serves at a path a post-only macro route also matches is taken for that
/// route's, a false 500; an `unstaged` route skips the stages this runs in, so it is not checked;
/// an `any = ..` route answers `GET` too; a post whose fetch metadata says it is not a top-level
/// navigation ([`top_level`]: a page's own `fetch`, a form posted into an `<iframe>`), whose
/// answer is not shown as the tab's page, or a navigation a service worker passes on, which may
/// be; a relayed upstream answer (`Relay`), checked by the
/// upstream; and a release build compiles none of it, so it never runs in a production image or a
/// smoke test against one.
#[cfg(debug_assertions)]
fn page_where_no_page_is(res: Response, shared: &Shared, path: &str) -> Response {
    if !res.status().is_success()
        || !res.headers().contains_key(SHELL_HEADER)
        || res.extensions().get::<crate::answer::Relayed>().is_some()
        || shared.not_pages.contains(path)
    {
        return res;
    }
    let Some((route, false)) = crate::route::chosen(&shared.pages, path) else { return res };
    in_place_of(
        res,
        shared.dev,
        format!(
            "a browser's post to {route}, which has no GET handler, was answered with a page, so the browser shows it at an address that answers 405 when it is opened again: post a form that belongs to one page to that page's route (get = .., post = ..), or answer this write with req.redirect or req.redirect_with_notice once it is done and draw a page only to refuse it (req.invalid)"
        ),
    )
}

/// A patch answering a browser's plain request (no `data-patch`, asking for HTML): the browser
/// shows the fragment as the whole document, with no layout, stylesheets or navigation, at the
/// request's address. [`Req::patch_or`] answers the page or a redirect then, and a handler that
/// binds `Some(action)` from `req.action()` itself answers its patch only in that mode. The route is
/// named as `#[corten::routes]` declares it, and by the request's path where no macro route
/// matches it (a hand-built `Table`'s). The handler's cookies and `Clear-Site-Data` go out with
/// the error page, as for [`page_where_no_page_is`].
///
/// What it does not see: a request whose fetch metadata says it is not a top-level navigation
/// ([`top_level`]: a page's own `fetch`, an `<iframe>`'s load), whose answer is not shown as the
/// tab's page, or a navigation a service worker passes on with `fetch(event.request)`, whose
/// answer may be; an `unstaged` route skips the stages this runs in; a fragment answered
/// without `corten-patch` (a response built by hand, or one put in place of the handler's through
/// `DerefMut`) is not a patch to it; a relayed upstream answer (`Relay`), checked by the
/// upstream; and a release build compiles none of it, so it never runs in a production image or a
/// smoke test against one.
#[cfg(debug_assertions)]
fn patch_where_a_page_belongs(res: Response, shared: &Shared, method: &http::Method, path: &str) -> Response {
    if !res.headers().contains_key(PATCH_HEADER) || res.extensions().get::<crate::answer::Relayed>().is_some() {
        return res;
    }
    let route = crate::route::chosen(&shared.pages, path).map_or(path, |(route, _)| route);
    in_place_of(
        res,
        shared.dev,
        format!(
            "a browser's plain {method} to {route} (no data-patch, asking for HTML) was answered with a patch, which the browser shows as the whole page, with no layout, stylesheets or navigation: answer both with req.patch_or(view, || async {{ .. }}), which draws the page or a redirect when the runtime did not ask, or bind Some(action) from req.action() before action.patch"
        ),
    )
}

/// Whether a request's fetch metadata, where the browser sent it, says it is a top-level
/// navigation (a link, a reload, a form the browser submits): `Sec-Fetch-Mode: navigate` to a
/// `Sec-Fetch-Dest: document`. A page's own `fetch` (`cors`, `same-origin`) and an `<iframe>`'s
/// load (`iframe`) are not, so what answers them is not shown as the tab's page. A client that
/// sends neither (a router test, an HTTP library) is taken at its `Accept`.
///
/// A navigation a service worker answers from navigation preload keeps its destination. One the
/// worker passes on with `fetch(event.request)` arrives as `navigate` to `empty`, the tab's and
/// a frame's alike, so it is not taken for the tab's: a known gap, since the worker may show its
/// answer as the tab's page (`docs/design.md#choice-plain-request-patch`).
///
/// Browsers send fetch metadata only to a secure context (HTTPS, `localhost`): a debug build
/// reached over plain HTTP at another address (a phone on the LAN) gets none, so a page's own
/// `fetch` that asks for `text/html` there is taken for a navigation, a false 500.
#[cfg(debug_assertions)]
fn top_level(headers: &HeaderMap) -> bool {
    headers.get("sec-fetch-mode").is_none_or(|mode| mode.as_bytes() == b"navigate")
        && headers.get("sec-fetch-dest").is_none_or(|dest| dest.as_bytes() == b"document")
}

/// The error a debug build answers in place of `res`, an answer a browser would have shown wrongly.
/// What the browser would have done with its cookies and stored data, it does with the error's
/// (`Set-Cookie`, `Clear-Site-Data`); its other headers are its own, which the error page's
/// replace.
#[cfg(debug_assertions)]
fn in_place_of(res: Response, dev: bool, message: String) -> Response {
    let (parts, _) = res.into_parts();
    let mut error = unserved(dev, message).into_response();
    for name in [header::SET_COOKIE, HeaderName::from_static("clear-site-data")] {
        for value in parts.headers.get_all(&name) {
            error.headers_mut().append(name.clone(), value.clone());
        }
    }
    crate::cache::unshared_in_place_of(&parts.extensions, error)
}

/// A write's redirect to an origin the form's page does not allow in `form-action`: Chromium
/// and WebKit stop the submission there, on the form's page, with only a console error, while
/// every test passes. A debug build answers it as an error that says so; a release build sends
/// it as it is.
#[cfg(debug_assertions)]
fn redirect_outside_form_action(res: Response, check: Option<&crate::security::FormCheck>, dev: bool) -> Response {
    let Some(check) = check else { return res };
    // A relayed answer is passed on as it came, under the policy it came with.
    if res.extensions().get::<crate::answer::Relayed>().is_some() {
        return res;
    }
    let to = match res.status() {
        status if status.is_redirection() => res.headers().get(header::LOCATION),
        StatusCode::NO_CONTENT => res.headers().get(LOCATION_HEADER),
        _ => None,
    };
    let Some(message) = to.and_then(|to| outside_form_action(check, to)) else { return res };
    // What the handler set besides the redirect (a session cookie, which the browser keeps even
    // when it stops the redirect) goes out with the error page.
    let (parts, _) = res.into_parts();
    let mut error = unserved(dev, message).into_response();
    let own: Vec<HeaderName> = error.headers().keys().cloned().collect();
    for (name, value) in &parts.headers {
        if name != header::LOCATION && name != LOCATION_HEADER && !own.contains(name) {
            error.headers_mut().append(name, value.clone());
        }
    }
    crate::cache::unshared_in_place_of(&parts.extensions, error)
}

/// What a debug build says of a write redirected to `to`, when the form's page does not allow it.
#[cfg(debug_assertions)]
fn outside_form_action(check: &crate::security::FormCheck, to: &HeaderValue) -> Option<String> {
    // A path, the common case, is the page's own origin: nothing else is worked out.
    if !crate::security::is_address(to.as_bytes()) {
        return None;
    }
    let targets = check.targets()?;
    if targets.allows(to.as_bytes()) {
        return None;
    }
    let origin = targets.origin(to.as_bytes());
    let stops = if check.action {
        "so without JavaScript a browser stops the same form there"
    } else {
        "so a browser stops the form there"
    };
    let own = if targets.own_unknown() {
        "; if it is the app's own origin, send a Host in the test or name it with Policy::host"
    } else {
        ""
    };
    Some(format!(
        "this write redirects to {origin}, which the form's page does not allow in its CSP's form-action, {stops} with only a console error: allow it with Policy::form_action(\"{origin}\") (Sources::form_action for an area), or redirect to a page of the app{own}"
    ))
}

/// How long the browser keeps a [`Req::moved`] redirect: a day, its own copy only.
const MOVED_CACHE: &str = "private, max-age=86400";

/// What a redirect varies on: its answer is `corten-location` or a redirect by the `corten`
/// header, so a cache (the browser's too, which `fetch` reads) keeps one for each value.
const MODE_VARY: &str = "corten";

/// A redirect in `mode`: `corten-location` for a form patch (the runtime navigates), a 303
/// otherwise. Any other request the runtime `fetched` (a navigation, the whole page after a write)
/// that is sent to a place on a page (`#id`) or to another site gets `corten-location` too:
/// `fetch` follows a 303 but drops its fragment, so the runtime would not know where to scroll,
/// and may not read another origin's answer.
pub(crate) fn redirect(mode: Mode, fetched: bool, to: HeaderValue) -> Response {
    let vary = (header::VARY, HeaderValue::from_static(MODE_VARY));
    match mode {
        Mode::Action => (StatusCode::NO_CONTENT, [(LOCATION_HEADER, to), vary]).into_response(),
        // `fetch` follows a redirect but drops its `#id`, and one to another origin is refused
        // (the CSP's `connect-src`, else CORS): the runtime navigates there itself. So for any
        // fetch of the runtime's, a navigation or the whole page after a write (#1034).
        _ if fetched && (has_fragment(&to) || elsewhere(&to)) => {
            (StatusCode::NO_CONTENT, [(LOCATION_HEADER, to), vary]).into_response()
        }
        _ => (StatusCode::SEE_OTHER, [(header::LOCATION, to), vary]).into_response(),
    }
}

fn has_fragment(to: &HeaderValue) -> bool {
    to.as_bytes().contains(&b'#')
}

/// An address outside the app: anything but a path on this origin (`https://..`, `//host/..`).
/// A route's address always starts with one `/`, and a `corten::http::Uri` is a path or absolute
/// (it cannot be relative).
fn elsewhere(to: &HeaderValue) -> bool {
    let to = to.as_bytes();
    to.first() != Some(&b'/') || to.get(1) == Some(&b'/')
}

/// Whether an address an [`crate::OnSite`] value wrote is a path on this site as a browser reads
/// it: one `/` first, then printable ASCII with no `\`, since a browser reads `\` as `/` and drops a
/// tab (`/\host`, `/<tab>/host` are `//host`). [`crate::Local::parse`]'s rule, without its `.`
/// segment check, which a derived `{*rest}` value may write.
fn on_site(to: &HeaderValue) -> bool {
    let to = to.as_bytes();
    to.first() == Some(&b'/')
        && !matches!(to.get(1), Some(b'/' | b'\\'))
        && to.iter().all(|&b| b.is_ascii_graphic() && b != b'\\')
}

/// The part module (`ReadAgain::now`, [`crate::script::PART_MODULE`]) for a page that draws a
/// part waiting: preloaded with the runtime, which imports it from beside itself, so the part's
/// read waits for no round trip of its own. `data-corten-part` is what the runtime looks for when
/// the page loads, in the head alone, so a page without one runs none of the module. A
/// navigation's answer brings it too, which the runtime moves into the head; the runtime imports
/// the module then from the part's tag in the markup.
fn part_preload(modules: &[&'static str], out: &mut String) {
    if modules.contains(&crate::script::PART_MODULE) {
        out.push_str(r#"<link rel="modulepreload" href=""#);
        out.push_str(crate::part_path());
        out.push_str(r#"" data-corten-part>"#);
    }
}

/// What a page whose handlers call an unserved script module is told.
#[cold]
fn unserved_module(name: &str) -> String {
    format!(
        "the page's handlers call the script module {name}.js, which the app does not serve, so they would do nothing: list the component it belongs to in App::components (for a script! module, its COMPONENT)"
    )
}

/// A failure a route of Corten's own answers as it is, not as the error page or JSON:
/// `/favicon.ico`'s 404 when the app has no icon, which no person reads and which must start no
/// layout read (#1056), and a static file's 416, whose `Content-Range` the page would drop (#1133).
#[derive(Clone, Copy)]
pub(crate) struct AsIs;

/// Middleware the app installs: a failed request (an [`Error`] from a handler, or an empty error
/// response such as the router's 404 for an unknown URL or 405 for a wrong method) renders the error
/// page in the request's mode, and the PWA's offline path gets Corten's offline page when the app
/// has no route for it. A [`Mode::Data`] request, every request on an `api` route and every
/// failure of a JSON route ([`crate::JsonResult`]) gets the failure as JSON instead
/// ([`crate::api`]). A request a [`crate::Caller`] sent to sign in is redirected there.
pub(crate) fn render_errors<'s, 'n, 'g, 'm, 'r, 'p, S: crate::app::Steps>(
    shared: &'s Arc<Shared>,
    mut pending: Inbound<'r>,
    next: Next<'n, S>,
    deadline: Option<std::time::Duration>,
    signal: &'g crate::Signal,
    api: Option<&'m crate::api::Mount>,
    page: &'p mut RequestPage,
) -> impl Future<Output = Response> + Send + use<'s, 'n, 'g, 'm, 'r, 'p, S> {
    let req = pending.get();
    let (mode, _) = page.mode;
    let mut late = false;
    if next.has_middleware() {
        // Middleware may change what is asked for or make the page itself, even on a patch-only
        // route. Allow late fill on a swap write with reads, but negotiate where the page is made.
        if mode != Mode::Data && api.is_none() && !matches!(*req.method(), http::Method::GET | http::Method::HEAD) {
            late = mode.swaps() && !shared.layout_reads.is_empty();
            signal.recheck_whole(late);
        }
    } else if mode == Mode::Action
        && api.is_none()
        && next.route_can_answer_action_page()
        && own_page_whole(mode, req.method(), req.headers())
    {
        // Without middleware the preference cannot change. A patch-only route need not read it.
        late = !shared.layout_reads.is_empty();
        signal.mark_whole(late);
    }
    errors_rendered(shared, pending, next, deadline, signal, api, page, late)
}

#[allow(clippy::too_many_arguments)]
async fn errors_rendered<S: crate::app::Steps>(
    shared: &Arc<Shared>,
    mut pending: Inbound<'_>,
    next: Next<'_, S>,
    deadline: Option<std::time::Duration>,
    signal: &crate::Signal,
    api: Option<&crate::api::Mount>,
    page: &mut RequestPage,
    late: bool,
) -> Response {
    let (mode, _) = page.mode;
    let json = api.is_some() || mode == Mode::Data;
    if late && !json {
        // Keep the late poller's state in this box, not in a second box or the ordinary future.
        let _release = ReleasesEarlyHeads(signal);
        let answer: std::pin::Pin<Box<dyn Future<Output = Response> + Send + '_>> = Box::pin(async move {
            crate::layout::LateWrite::stage(pending.get(), deadline);
            let dispatch = |pending| within_late(pending, next, deadline, signal);
            page_or_error(shared, pending, dispatch, deadline, signal, page).await
        });
        return answer.await;
    }
    let dispatch = |pending| within_deadline(pending, next, deadline);
    if json {
        let shape = api.and_then(|mount| mount.errors.as_ref());
        return crate::api::json_failure(run(pending, dispatch, deadline, signal).await, shared.dev, shape).await;
    }
    if shared.layout_reads.is_empty() || mode.swaps() {
        return page_or_error(shared, pending, dispatch, deadline, signal, page).await;
    }
    // A whole document: a page route starts the layout's reads as it is called, and they are
    // polled with the handler on this task, then drawn into whichever page answers: the
    // handler's as the route returns (before the app's middleware sees it), or the error page.
    // Boxed, so the request's future in an app without layout reads stays the size it was: it
    // is moved as it is polled, and with the reads' state inline each request ran about 9.5k more
    // instructions, 8.4k of them copying (callgrind, the item page).
    let until = deadline.map(|limit| tokio::time::Instant::now() + limit);
    let here = crate::layout::StartHere::new(shared.clone(), until);
    pending.get().extensions_mut().insert(here.clone());
    let filled: std::pin::Pin<Box<dyn Future<Output = Response> + Send + '_>> = Box::pin(async move {
        let res = here.beside(page_or_error(shared, pending, dispatch, deadline, signal, page)).await;
        here.fill(res).await
    });
    filled.await
}

/// Lets go of the heads `Req`s took before a late write's route once the write
/// is answered, or dropped unanswered (the client gone, a middleware's timeout): they are kept on
/// the request's signal, which each holds in its extensions, so left there a head and the signal
/// would keep each other, and all the head holds, past the request. A `Req` taken after this keeps
/// none (#1370).
struct ReleasesEarlyHeads<'g>(&'g crate::Signal);

impl Drop for ReleasesEarlyHeads<'_> {
    fn drop(&mut self) {
        self.0.release_early_heads();
    }
}

/// The handler's page, or the error page in its place.
async fn page_or_error<'r, F: Future<Output = Result<Response, Late>>>(
    shared: &Arc<Shared>,
    mut pending: Inbound<'r>,
    dispatch: impl FnOnce(Inbound<'r>) -> F,
    deadline: Option<std::time::Duration>,
    signal: &crate::Signal,
    page: &mut RequestPage,
) -> Response {
    use http_body::Body as HttpBody;
    let req = pending.get();
    let offline = req.method() == http::Method::GET && shared.offline.as_deref() == Some(req.uri().path());
    // A browser: the runtime (whose whole-page fetch asks for `*/*`), or a document request that
    // asks for HTML (a health probe or a webhook sender does not).
    let browser = page.mode.1 || page.accepts_html;
    let asked = Asked::new(req, shared, page, req.extensions().get::<NonceSlot>(), signal);
    #[cfg(debug_assertions)]
    let check = page.form_check.take();
    // A browser's plain request (a link, a reload, a form without JavaScript), which shows what
    // answers it as the whole document at the address it asked; its method, for what it is told.
    #[cfg(debug_assertions)]
    let plain = (page.accepts_html && !page.mode.1 && top_level(req.headers())).then(|| req.method().clone());
    let res = run(pending, dispatch, deadline, signal).await;
    #[cfg(debug_assertions)]
    let res = refresh_header_is_an_error(res, shared.dev);
    #[cfg(debug_assertions)]
    let res = match &plain {
        Some(method) => {
            let res = patch_where_a_page_belongs(res, shared, method, asked.path());
            // A plain form post, which leaves the browser at the address it posted to.
            if *method == http::Method::POST {
                page_where_no_page_is(res, shared, asked.path())
            } else {
                res
            }
        }
        None => res,
    };
    #[cfg(debug_assertions)]
    let mut res = redirect_outside_form_action(res, check.as_ref(), shared.dev);
    #[cfg(not(debug_assertions))]
    let mut res = res;
    let status = res.status();
    let error = status.is_client_error() || status.is_server_error();
    // A refusal goes out as it was made (a `200` an extractor's rejection chose, a redirect, a
    // relayed failure): its mark is on it, and the app's cache rule reads it as it goes out
    // ([`crate::cache::Unshared`]).
    if !error || res.extensions().get::<crate::answer::Relayed>().is_some() || res.extensions().get::<AsIs>().is_some() {
        return res;
    }
    // A JSON route answers every failure as JSON, a path that did not parse included.
    if res.extensions().get::<crate::answer::Answered>().is_some() {
        // Not kept across the await, so the request's future stays as small as it was.
        drop(asked);
        return crate::api::json_failure(res, shared.dev, None).await;
    }
    // A `NoStore` answer: the page that replaces it is one too; and one that is no handler's own (a
    // refusal, the router's own failure, a panic, the deadline), which the page in its place is too.
    let marks = crate::cache::Marks::of(res.extensions());
    if let Some(crate::caller::SignIn(to)) = res.extensions().get::<crate::caller::SignIn>().cloned() {
        // A refusal, whoever made it: the redirect or page in its place is never shared either.
        let marks = crate::cache::Marks { unshared: true, ..marks };
        let kept = std::mem::take(res.headers_mut());
        let Some(message) = sign_in_loops(asked.path(), &to) else {
            #[cfg(debug_assertions)]
            if let Some(message) = check.as_ref().and_then(|check| outside_form_action(check, &to)) {
                // About the app's code, as `unserved`'s are: the detail stays outside dev too.
                tracing::error!("corten: {message}");
                print_unserved(shared.dev, &message);
                let failure = Failure::Failed { status: StatusCode::INTERNAL_SERVER_ERROR, detail: Some(Arc::from(message)) };
                return carried(kept, marks, error_page(shared, asked, failure).await);
            }
            return carried(kept, marks, redirect(asked.mode, asked.fetched, to));
        };
        tracing::error!("corten: {message}");
        let failure = Failure::Failed { status: StatusCode::INTERNAL_SERVER_ERROR, detail: Some(Arc::from(message)) };
        let failure = if shared.dev { failure } else { failure.without_detail() };
        return carried(kept, marks, error_page(shared, asked, failure).await);
    }
    let mut failed = res.extensions().get::<crate::Failed>().cloned();
    // Read here, before the answer's body is taken; not in a release build, where it would be one
    // more value every request's future holds across the await below.
    #[cfg(debug_assertions)]
    let keeps_detail = res.extensions().get::<KeepsDetail>().is_some();
    let empty_error = res.body().size_hint().exact() == Some(0);
    // The router's mark counts only while its empty `501` is still the answer: a middleware that
    // turned it into another status, or wrote a body of its own, answered it itself, and that
    // answer is kept as on the JSON path (a plain-text body as a rejection, below; an empty one of
    // unknown size as it is).
    let cause = res
        .extensions()
        .get::<Cause>()
        .copied()
        .filter(|cause| !matches!(cause, Cause::UnknownMethod) || (status == StatusCode::NOT_IMPLEMENTED && empty_error));
    // An extractor's rejection (a form field missing, a path segment that does not parse) is
    // plain text written for a developer. A browser gets the error page instead, with the text
    // under it in dev mode; any other client (probes, webhooks) still gets the text.
    let rejection = failed.is_none() && cause.is_none() && browser && crate::api::is_plain_text(res.headers());
    if failed.is_none() && cause.is_none() && !empty_error && !rejection {
        // A failure sent as it is: to a client that does not ask for HTML, or with a body that is
        // not plain text. Its marks go out with it.
        return res;
    }
    // What the handler and the app's middleware said besides the body (a request id,
    // `Retry-After`, `WWW-Authenticate`, `Allow`) goes out with the error page.
    let kept = std::mem::take(res.headers_mut());
    if rejection {
        // The body alone: the answer's extensions are read again once the page is drawn.
        let text = crate::body::to_bytes(std::mem::take(res.body_mut()), 16 * 1024).await.unwrap_or_default();
        let text = String::from_utf8_lossy(&text);
        tracing::debug!(status = status.as_u16(), "corten: request rejected: {text}");
        failed = Some(crate::Failed(Arc::from(text.trim())));
    }
    if offline && status == StatusCode::NOT_FOUND {
        // The PWA's offline page, which the service worker keeps: a 200. It is the app's error page
        // in place of the router's `404`, so it is settled as one too; the worker's own cache keeps
        // it whatever its `Cache-Control` says.
        return carried_from(kept, marks, error_page(shared, asked, Failure::Offline).await, res.extensions_mut());
    }
    let detail = failed.map(|crate::Failed(message)| message);
    let failure = match cause {
        Some(Cause::Panicked) => Failure::Panicked { detail },
        Some(Cause::TimedOut) => Failure::TimedOut,
        Some(Cause::Refused) => Failure::Refused { status },
        Some(Cause::Unidentified) => Failure::Unidentified { detail },
        Some(Cause::UnknownMethod) => Failure::UnknownMethod,
        None if rejection => Failure::Rejected { status, detail },
        // Nothing is here, whether no route has the URL or the handler found nothing.
        None if status == StatusCode::NOT_FOUND => Failure::NotFound,
        None if detail.is_some() => Failure::Failed { status, detail },
        None => match status {
            StatusCode::METHOD_NOT_ALLOWED => Failure::WrongMethod,
            // A handler's or a middleware's empty `501` among them: only the router's is marked.
            status => Failure::Failed { status, detail: None },
        },
    };
    #[cfg(debug_assertions)]
    let shows = shared.dev || keeps_detail;
    #[cfg(not(debug_assertions))]
    let shows = shared.dev;
    let failure = if shows { failure } else { failure.without_detail() };
    carried_from(kept, marks, error_page(shared, asked, failure).await, res.extensions_mut())
}

/// [`carried`], for the error page drawn in the place of the failed answer whose extensions are
/// `answer`: when they hold its `Unshared` mark alone and the page has none (the router's `404`
/// with the error page), the page takes that map, rather than a new one made for the same mark.
/// Nothing else of the failed answer's is carried. `answer` is borrowed after the page is drawn,
/// so the request's future holds nothing more across that await.
fn carried_from(kept: HeaderMap, marks: crate::cache::Marks, mut res: Response, answer: &mut http::Extensions) -> Response {
    if marks.unshared && !marks.no_store && answer.len() == 1 && res.extensions().is_empty() {
        *res.extensions_mut() = std::mem::take(answer);
        return carried(kept, crate::cache::Marks { unshared: false, no_store: false }, res);
    }
    carried(kept, marks, res)
}

/// [`Req::asset`] with no static directory: a bug, which panics in debug builds.
#[cold]
fn no_assets(path: &'static str) -> crate::assets::AssetUrl<'static> {
    let message = format!("corten: no static directory is loaded, so there is no {path:?}; see App::assets");
    if cfg!(debug_assertions) {
        panic!("{message}");
    }
    tracing::error!("{message}");
    crate::assets::AssetUrl::unserved(path)
}

/// `res` with the headers of the failed response it replaces, `kept`, except the ones that
/// described its body or that Corten sets for the answer it sends (`Cache-Control`, its own
/// `corten-` headers); a header `res` has already wins, but for `Vary`, whose names are added to
/// its own (each one it does not name already, in any case), since what the failed answer varied
/// on still decides this one. A `Cache-Control` that names `no-store` (`NoStore`, or one written
/// by hand, on any of its lines, however a reader could find it) makes `res` `no-store` too:
/// whoever set it said nothing may keep the answer, a failure included. Its other directives
/// described the failed answer, so they are not carried. `res` gets the failed answer's `marks`
/// ([`crate::cache::Marks`]): the page that replaces a `NoStore` answer is `NoStore` too, whatever
/// a middleware made of the answer's header, and the page in place of an answer that is no
/// handler's own (a refusal, a failure no handler answered) is never shared, by the app's cache
/// rule or another app's that relays it inline. A plain-text failure a browser gets the error page
/// for (an extractor's rejection is marked where it was made) is only that: a handler's own is
/// its answer.
fn carried(kept: HeaderMap, marks: crate::cache::Marks, mut res: Response) -> Response {
    marks.put(&mut res);
    if kept.is_empty() {
        return res;
    }
    use http::header::Entry;
    let headers = res.headers_mut();
    if !marks.no_store && kept.get_all(header::CACHE_CONTROL).iter().any(|line| crate::cache::mentions_no_store(line.as_bytes()))
    {
        headers.insert(header::CACHE_CONTROL, crate::cache::NO_STORE);
    }
    // Allocates only for a failure that varied on something.
    let vary: Vec<HeaderValue> = kept.get_all(header::VARY).iter().cloned().collect();
    let mut kept_name = None;
    // A name comes with its first value only; the values after it have `None`.
    for (key, value) in kept {
        if let Some(key) = key {
            kept_name = None;
            let replaced = matches!(
                key,
                header::CONTENT_TYPE
                    | header::CONTENT_LENGTH
                    | header::CONTENT_ENCODING
                    | header::CONTENT_LANGUAGE
                    | header::CONTENT_DISPOSITION
                    | header::CONTENT_RANGE
                    | header::TRANSFER_ENCODING
                    | header::ETAG
                    | header::LAST_MODIFIED
                    | header::CACHE_CONTROL
                    | header::VARY
            ) || key.as_str().starts_with("corten-");
            if !replaced {
                if let Entry::Vacant(entry) = headers.entry(key) {
                    kept_name = Some(entry.insert_entry(value));
                }
            }
        } else if let Some(entry) = &mut kept_name {
            entry.append(value);
        }
    }
    // Each name once: a name the answer varies on already, on any of its lines, or earlier on the
    // same line, is not added again. A value that is not text is kept as it came: a cache is safer
    // varying on too much than too little.
    for value in vary {
        let Ok(text) = value.to_str() else {
            res.headers_mut().append(header::VARY, value);
            continue;
        };
        let mut new: Vec<&str> = Vec::new();
        for name in text.split(',').map(str::trim).filter(|name| !name.is_empty()) {
            let had = res
                .headers()
                .get_all(header::VARY)
                .iter()
                .filter_map(|own| own.to_str().ok())
                .flat_map(|own| own.split(','))
                .any(|own| own.trim().eq_ignore_ascii_case(name));
            if !had && !new.iter().any(|seen| seen.eq_ignore_ascii_case(name)) {
                new.push(name);
            }
        }
        if !new.is_empty() {
            if let Ok(value) = HeaderValue::from_str(&new.join(", ")) {
                res.headers_mut().append(header::VARY, value);
            }
        }
    }
    res
}

/// Why a request a [`crate::Caller`] sent to sign in at `to` would loop: the sign-in page itself
/// needs a caller, so the browser would be sent round until it gives up. `None` when it does not.
fn sign_in_loops(path: &str, to: &HeaderValue) -> Option<String> {
    let target = to.to_str().unwrap_or("");
    (target.split(['?', '#']).next() == Some(path)).then(|| {
        format!("{path} needs a caller and sends to sign in at {target}, itself: the sign-in page's handler cannot take Caller")
    })
}

/// The handler's response, its deadline failure or, if it panics, a 500 whose message only
/// `corten dev` shows.
async fn run<'r, F: Future<Output = Result<Response, Late>>>(
    mut pending: Inbound<'r>,
    dispatch: impl FnOnce(Inbound<'r>) -> F,
    deadline: Option<std::time::Duration>,
    signal: &crate::Signal,
) -> Response {
    use std::{panic::AssertUnwindSafe, pin::pin, task::Poll};
    // For the log only: a method and a URI clone without allocating.
    let req = pending.get();
    let (method, uri) = (req.method().clone(), req.uri().clone());
    // Both dispatchers only construct a future here. Polling it, including taking the request
    // and answering a timeout, stays inside the panic catch.
    let mut fut = pin!(dispatch(pending));
    let outcome = std::future::poll_fn(|cx| {
        match std::panic::catch_unwind(AssertUnwindSafe(|| {
            fut.as_mut()
                .poll(cx)
                .map(|result| result.unwrap_or_else(|late| deadline_failure(late, deadline, signal, (&method, &uri))))
        })) {
            Ok(Poll::Ready(res)) => Poll::Ready(Ok(res)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(panic) => Poll::Ready(Err(panic)),
        }
    })
    .await;
    match outcome {
        Ok(res) => res,
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "a panic with no message".to_string());
            tracing::error!("corten: {method} {} panicked: {message}", uri.path());
            let mut res = Error::corten(format!("the handler panicked: {message}")).into_response();
            res.extensions_mut().insert(Cause::Panicked);
            res
        }
    }
}

fn deadline_failure(
    Late(waited): Late,
    deadline: Option<std::time::Duration>,
    signal: &crate::Signal,
    (method, uri): (&http::Method, &Uri),
) -> Response {
    match waited {
        // The handler was waiting for the client to send the rest of the body: the request had
        // not arrived whole in time, which is the client's 408 (a stalled upload with the
        // defaults, whose idle time is longer than the deadline), not the server's 503. Still
        // warned of, as the 503 is: a large upload still being sent says the deadline is short.
        Waited::Body => {
            let limit = deadline.expect("timed out");
            signal.abort(crate::Abort::Deadline);
            tracing::warn!("corten: {method} {} passed its {limit:?} deadline waiting for the request's body", uri.path());
            Error::corten("the request's body did not arrive in time").with_status(StatusCode::REQUEST_TIMEOUT).into_response()
        }
        // A body over its limit, read past so the client reads the 413: still the 413.
        Waited::PastLimit(over) => {
            signal.abort(crate::Abort::Deadline);
            // Corten's own errors ([`Error::corten`]).
            match over {
                Over::Body(limit) => Error::from(crate::extract::BodyError::TooLarge { limit }),
                Over::Upload(limit) => Error::from(crate::form::UploadError::TooLarge { limit }),
            }
            .into_response()
        }
        Waited::Nothing => {
            let limit = deadline.expect("timed out");
            signal.abort(crate::Abort::Deadline);
            tracing::warn!("corten: {method} {} passed its {limit:?} deadline", uri.path());
            let mut res = crate::cache::unshared(StatusCode::SERVICE_UNAVAILABLE.into_response());
            res.extensions_mut().insert(Cause::TimedOut);
            res
        }
    }
}

/// Dispatch the ordinary request with only the state its deadline can need.
async fn within_deadline<S: crate::app::Steps>(
    pending: Inbound<'_>,
    next: Next<'_, S>,
    deadline: Option<std::time::Duration>,
) -> Result<Response, Late> {
    let req = pending.take();
    if let Some(limit) = deadline {
        within(limit, next.run(req)).await
    } else {
        Ok(next.run(req).await)
    }
}

/// [`within`] waited its limit, and what the future's last poll waited for of the request body
/// ([`crate::extract::Arriving`]).
struct Late(Waited);

/// `fut`'s output, or [`Late`] once it has waited `limit`. The timer starts the first time `fut`
/// is not ready, so a handler that answers at once (a page rendered from memory) never registers
/// one: about 600 ns a request measured with `tokio::time::timeout`. It is the connection's where
/// the connection keeps one ([`crate::deadline`]). Each poll of `fut` starts
/// with no wait for the body marked, so the mark read when the timer fires is that poll's.
async fn within<F: Future>(limit: std::time::Duration, fut: F) -> Result<F::Output, Late> {
    use std::{pin::pin, task::Poll};
    let mut fut = pin!(fut);
    let mut timer = pin!(crate::deadline::Timer::Unset);
    std::future::poll_fn(|cx| {
        crate::extract::forget_wait();
        if let Poll::Ready(out) = fut.as_mut().poll(cx) {
            return Poll::Ready(Ok(out));
        }
        waited_until(timer.as_mut(), limit, cx)
    })
    .await
}

/// Like `within`, with one more possible stage: filling a page that no typed route has filled.
async fn within_late<S: crate::app::Steps>(
    pending: Inbound<'_>,
    next: Next<'_, S>,
    limit: Option<std::time::Duration>,
    signal: &crate::Signal,
) -> Result<Response, Late> {
    use std::{future::Future, pin::pin, task::Poll};
    let mut fut = pin!(Some(next.run(pending.take())));
    let mut timer = pin!(crate::deadline::Timer::Unset);
    let mut fill: Option<std::pin::Pin<Box<dyn Future<Output = Response> + Send>>> = None;
    std::future::poll_fn(|cx| {
        if limit.is_some() {
            crate::extract::forget_wait();
        }
        if let Some(answer) = fut.as_mut().as_pin_mut() {
            if let Poll::Ready(res) = answer.poll(cx) {
                // A page the middleware (or a raw route) made early can still have places.
                // Only that answer needs a fill, under the existing deadline and panic catch.
                if res.extensions().get::<crate::layout::Pending>().is_none() {
                    return Poll::Ready(Ok(res));
                }
                // The middleware's future is finished; do not hold it across the reads.
                fut.set(None);
                let shared = signal.shared().expect("late writes belong to an app");
                fill = Some(Box::pin(crate::layout::fill_made_early(shared.clone(), res)));
            }
        }
        if let Some(fill) = &mut fill {
            if let Poll::Ready(res) = fill.as_mut().poll(cx) {
                return Poll::Ready(Ok(res));
            }
        }
        let Some(limit) = limit else { return Poll::Pending };
        waited_until(timer.as_mut(), limit, cx)
    })
    .await
}

#[inline]
fn waited_until<T>(
    timer: std::pin::Pin<&mut crate::deadline::Timer>,
    limit: std::time::Duration,
    cx: &mut std::task::Context<'_>,
) -> std::task::Poll<Result<T, Late>> {
    timer.poll(limit, cx).map(|()| Err(Late(crate::extract::waited())))
}

thread_local! {
    /// Where `<Corten />` was written in the document being rendered.
    static HEAD_AT: Cell<Option<usize>> = const { Cell::new(None) };
}

/// Where Corten writes its tags in a document's `<head>`: the import map, the runtime, the
/// page's script modules, the app's configured tags (manifest, theme color) and the key that
/// tells the runtime whether the page around `<main>` is current. A document holds it once, after
/// its `<title>`: `<head>..<title>{title}</title>{head}<Corten /></head>`.
pub struct Corten;

impl Render for Corten {
    #[inline]
    fn render(&self, out: &mut String) {
        HEAD_AT.set(Some(out.len()));
    }
}

/// A page that shows a read still catching up with a write ("saved, updating") asks to be read
/// again after `after` (whole seconds, at least one), however it was reached (a full load, a
/// navigation, a form's redirect). It goes among the page's head tags, which the layout puts in
/// `<head>`: `head={pending.then_some(ReadAgain { after: Duration::from_secs(2) })}`.
///
/// The runtime fetches the same URL and swaps it in, replacing the history entry and keeping the
/// scroll position and the focused element (by its id); a navigation away stops it, and a hidden
/// tab waits until it is shown. Without JavaScript the browser reloads the page
/// (`<meta http-equiv="refresh">` in `<noscript>`). The page asks again each time it is read, so
/// it stops when the server stops asking (the write has landed, or is too old to wait for).
///
/// Not the `Refresh` header: browsers keep a full load's header after the runtime has navigated
/// away, and then load that first URL again. Debug builds answer 500 to a page that sends one.
///
/// A `data-patch` form's answer asks the same with [`ReadAgain::from`], and so does a page that
/// should have only some of its parts read again; with JavaScript, a page that does is not read
/// whole, so its head's `ReadAgain` is then for a browser without it. A page that keeps itself
/// fresh another way (a `<corten-live>` relaying the part) asks a browser without JavaScript only:
/// [`ReadAgain::without_javascript`].
#[derive(Clone, Copy, Debug)]
pub struct ReadAgain {
    /// How long until the page is read again.
    pub after: std::time::Duration,
}

impl ReadAgain {
    /// Whole seconds, at least one.
    fn seconds(self) -> u64 {
        (self.after.as_secs() + u64::from(self.after.subsec_nanos() > 0)).max(1)
    }

    /// In a patch (a `data-patch` form's answer, [`Action::patch`]) whose part shows a read still
    /// catching up with the write: after `after`, the runtime fetches `route` as a GET
    /// `data-patch` form would (`corten: action`) and applies the patch it answers, which asks
    /// again while it is behind. The route says `patches` and its `get` handler returns
    /// `HtmlResult<Patches>` ([`crate::Patches`]), answering with [`Req::patch_or`] (the part,
    /// or the page without JavaScript), so the handler's answer to the read is a patch (what
    /// answers before the handler, a stage or an extractor, is not checked); its URL carries what
    /// the read waits for (the write's receipt), since the page's own address does not.
    ///
    /// The read waits while the tab is hidden or a form's answer is on its way, keeps what the
    /// user typed, opened and focused as any patch does, and stops once an element the patch put
    /// on the page is replaced (a later patch, a navigation away) or the read fails. Without
    /// JavaScript a form gets a page, never a patch, so the page's own [`ReadAgain`] applies.
    ///
    /// In a page's markup (the first load or a navigation) it starts the same read once the page
    /// is on the screen, beside the parts it reads: it stops when the page is left or an element
    /// with an id beside it is replaced. With JavaScript, the page's own [`ReadAgain`] then does
    /// not read the page whole; it stays for a browser without JavaScript.
    ///
    /// ```
    /// use std::time::Duration;
    /// use corten::{prelude::*, view::Patch};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/alerts", get = alerts, patches)]
    ///     pub struct Alerts<'a> {
    ///         pub after: Option<&'a str>,
    ///     }
    /// }
    /// # async fn alerts(req: Req) -> HtmlResult<Patches> { req.patch_or(html! {}, || async { req.redirect(&corten::Local::parse("/").unwrap()) }).await }
    ///
    /// #[derive(Id)]
    /// struct AlertsId;
    ///
    /// fn saving<'a>(from: &'a url::Alerts<'a>) -> impl Patch + 'a {
    ///     let again = ReadAgain { after: Duration::from_secs(2) };
    ///     html! { <section id={AlertsId}>"Saving..."</section> {again.from(from)} }
    /// }
    /// let from = url::Alerts { after: Some("r7") };
    /// assert_eq!(
    ///     saving(&from).to_html(),
    ///     r#"<section id="alerts">Saving...</section><template data-corten-read-again="2" data-from="/alerts?after=r7"></template>"#
    /// );
    /// ```
    ///
    /// It takes the route by value too, so a component that is part of the page and the patch
    /// builds the read in its body and returns it:
    ///
    /// ```
    /// # use std::time::Duration;
    /// # use corten::prelude::*;
    /// # #[corten::routes]
    /// # mod url {
    /// #     #[route("/alerts", get = alerts, patches)]
    /// #     pub struct Alerts<'a> { pub after: Option<&'a str> }
    /// # }
    /// # async fn alerts(req: Req) -> HtmlResult<Patches> { req.patch_or(html! {}, || async { req.redirect(&corten::Local::parse("/").unwrap()) }).await }
    /// # use url::Alerts;
    /// #[derive(Id)]
    /// struct ListId;
    ///
    /// fn list(after: &str, saving: bool) -> impl Patch + '_ {
    ///     let again = saving.then(|| ReadAgain { after: Duration::from_secs(2) }.from(Alerts { after: Some(after) }));
    ///     html! { <ul id={ListId}></ul> {again} }
    /// }
    /// assert!(list("r7", true).to_html().ends_with(r#"data-from="/alerts?after=r7"></template>"#));
    /// ```
    ///
    /// A URL written as text does not compile:
    ///
    /// ```compile_fail,E0277
    /// use std::time::Duration;
    /// use corten::prelude::*;
    ///
    /// let _ = ReadAgain { after: Duration::from_secs(2) }.from("/alerts?after=r7");
    /// ```
    ///
    /// Nor does a route whose handler may answer its page: the runtime's read would get no patch,
    /// and the part would stay as it is. A route says `patches` for that, which holds its `get`
    /// handler to `HtmlResult<Patches>`:
    ///
    /// ```compile_fail,E0277
    /// use std::time::Duration;
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/alerts", get = alerts)]
    ///     pub struct Alerts;
    /// }
    ///
    /// async fn alerts(req: Req) -> HtmlResult {
    ///     req.page(html! { <html><head><title>"Alerts"</title><Corten /></head><body><main>"Alerts"</main></body></html> })
    /// }
    ///
    /// let _ = ReadAgain { after: Duration::from_secs(2) }.from(url::Alerts);
    /// ```
    ///
    /// and nor does a route given by hand, a `#[derive(Route)]` struct, whose handler the compiler
    /// cannot see:
    ///
    /// ```compile_fail,E0277
    /// use std::time::Duration;
    /// use corten::prelude::*;
    ///
    /// #[derive(Route)]
    /// #[route("/alerts")]
    /// struct Alerts;
    ///
    /// let _ = ReadAgain { after: Duration::from_secs(2) }.from(Alerts);
    /// ```
    pub fn from<R: crate::route::PatchRoute>(self, route: R) -> ReadAgainFrom<R> {
        ReadAgainFrom { again: self, route }
    }

    /// A part the page draws waiting for a read of its own (a slow one), read at once from `route`,
    /// the page's own route, once the page is on the screen. The tag goes in the element drawn
    /// waiting, whose id the patch replaces, so the tag and its part leave and arrive together:
    /// `<p id={PicksId}>"Finding picks..." {ReadAgain::now(url::Home::default())}</p>`. The
    /// runtime fetches `route` as [`ReadAgain::from`] does (`corten: action`), whether the tab
    /// is shown or not, and applies the patch it answers. The route says `patches`, and its
    /// handler answers with [`Req::patch_or_with`]: the part side reads only the part, and the
    /// page side draws the part waiting with this, so one handler answers the page and its part.
    ///
    /// The part (the element the tag is in) is `aria-busy="true"` while the read is on its way,
    /// and the read depends on it alone: a patch of any other element meanwhile (a cell beside it,
    /// a live row) changes nothing. A part the read does not replace (offline, the server
    /// unreachable, an error page, a page, a redirect, a patch without it, or the part replaced
    /// or removed meanwhile) is marked `data-corten-read-failed`, where the part's CSS shows its
    /// link to the page with the part read in, as it does without JavaScript, which reads
    /// nothing; the link follows a redirect (a sign-in) as any navigation does
    /// (`docs/design.md#choice-slow-part-link`). Tags that name the same address share one read,
    /// so two parts one read draws (a tag in each) are answered by one patch, and each waits for
    /// the slowest of what that answer reads: independent slow parts on one route take a query
    /// field each, so each has its own address. A part is read once: its answer is read again
    /// only if it asks, with [`ReadAgain::from`]. A part a form's answer draws waiting is read
    /// too; one an answer to a part's read draws waiting is marked failed, so one read cannot
    /// start another. The reads are a script module of their own, which only a page that draws
    /// this loads, preloaded with the runtime.
    ///
    /// ```
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home, patches)]
    ///     pub struct Home;
    /// }
    /// # async fn home(req: Req) -> HtmlResult<Patches> { req.action().ok_or_else(corten::Error::not_found)?.patch(html! {}) }
    ///
    /// #[derive(Id)]
    /// struct PicksId;
    ///
    /// assert_eq!(
    ///     html! { <p id={PicksId}>"Finding picks..." {ReadAgain::now(url::Home)}</p> }.to_html(),
    ///     r#"<p id="picks">Finding picks...<template data-corten-read-now data-from="/"></template></p>"#
    /// );
    /// ```
    ///
    /// A route whose handler may answer its page does not compile, as for [`ReadAgain::from`]:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home)]
    ///     pub struct Home;
    /// }
    /// # async fn home(req: Req) -> HtmlResult { req.redirect(&url::Home) }
    ///
    /// let _ = ReadAgain::now(url::Home);
    /// ```
    ///
    /// Nor is it an element a patch replaces by id: in a patch it goes inside one, as in a page.
    ///
    /// ```compile_fail,E0277
    /// use corten::{prelude::*, view::Patch};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/", get = home, patches)]
    ///     pub struct Home;
    /// }
    /// # async fn home(req: Req) -> HtmlResult<Patches> { req.action().ok_or_else(corten::Error::not_found)?.patch(html! {}) }
    ///
    /// fn waiting() -> impl Patch {
    ///     ReadAgain::now(url::Home)
    /// }
    /// ```
    pub fn now<R: crate::route::PatchRoute>(route: R) -> ReadNow<R> {
        ReadNow { route }
    }

    /// Asks only a browser without JavaScript to read the page again: for a page that keeps
    /// itself fresh with a script, such as one whose changing part a `<corten-live>` relays
    /// while the job it follows runs. With JavaScript the page is not read whole (which would
    /// replace the `<corten-live>` and open its stream again); without it, the browser reloads it.
    /// A page whose stream is unrelated to what it waits for (a ticker beside a saving form) uses
    /// plain [`ReadAgain`].
    ///
    /// ```
    /// use std::time::Duration;
    /// use corten::prelude::*;
    ///
    /// let again = ReadAgain { after: Duration::from_secs(2) }.without_javascript();
    /// assert_eq!(again.to_html(), r#"<noscript><meta http-equiv="refresh" content="2"></noscript>"#);
    /// ```
    pub fn without_javascript(self) -> ReadAgainWithoutJavaScript {
        ReadAgainWithoutJavaScript(self)
    }
}

/// [`ReadAgain::without_javascript`]: `<noscript>` and its refresh, without the mark the
/// runtime reads.
#[derive(Clone, Copy, Debug)]
pub struct ReadAgainWithoutJavaScript(ReadAgain);

impl Render for ReadAgainWithoutJavaScript {
    fn render(&self, out: &mut String) {
        use std::fmt::Write;
        let _ = write!(out, r#"<noscript><meta http-equiv="refresh" content="{}"></noscript>"#, self.0.seconds());
    }
}

impl Render for ReadAgain {
    fn render(&self, out: &mut String) {
        use std::fmt::Write;
        let seconds = self.seconds();
        let _ = write!(
            out,
            r#"<noscript data-corten-read-again="{seconds}"><meta http-equiv="refresh" content="{seconds}"></noscript>"#
        );
    }
}

/// A patch's or a page's request to be read again from a route, made by [`ReadAgain::from`]:
/// `<template data-corten-read-again="2" data-from="/alerts?after=r7">`.
pub struct ReadAgainFrom<R> {
    again: ReadAgain,
    route: R,
}

impl<R: crate::route::Route> Render for ReadAgainFrom<R> {
    fn render(&self, out: &mut String) {
        use std::fmt::Write;
        let _ = write!(out, r#"<template data-corten-read-again="{}" data-from=""#, self.again.seconds());
        self.route.write_href(out, true);
        out.push_str(r#""></template>"#);
    }
}

impl<R: crate::route::Route> crate::view::__private::PatchSealed for ReadAgainFrom<R> {}
impl<R: crate::route::Route> crate::view::Patch for ReadAgainFrom<R> {}

/// A part's read from the page's own route, at once, made by [`ReadAgain::now`]:
/// `<template data-corten-read-now data-from="/">`, in the element it waits for. Not a
/// [`crate::view::Patch`]. Rendering it notes the part module, so the page's head preloads it.
pub struct ReadNow<R> {
    route: R,
}

impl<R: crate::route::Route> Render for ReadNow<R> {
    fn render(&self, out: &mut String) {
        crate::script::uses(crate::script::PART_MODULE);
        out.push_str(r#"<template data-corten-read-now data-from=""#);
        self.route.write_href(out, true);
        out.push_str(r#""></template>"#);
    }
}

/// Structured data for search engines (a product, its breadcrumbs), as
/// `<script type="application/ld+json">`, among a page's head tags:
/// `head={JsonLd { value: &product }}`, or `<JsonLd value={&product} />` in `html!`. The value
/// is any [`crate::json::ToJson`]; its `<` are written `\u003c`, which JSON reads the same, so no
/// text in it (a seller's description that says `</script>`) can end the element. It is data,
/// not a script, so the CSP does not apply.
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(corten::ToJson)]
/// struct Product<'a> {
///     #[serde(rename = "@type")]
///     kind: &'a str,
///     name: &'a str,
/// }
///
/// let ld = JsonLd { value: &Product { kind: "Product", name: "</script><b>" } };
/// assert_eq!(
///     html! { {ld} }.to_html(),
///     r#"<script type="application/ld+json">{"@type":"Product","name":"\u003c/script>\u003cb>"}</script>"#
/// );
/// ```
///
/// An expression inside `<script>` or `<style>` would be escaped as HTML text, which neither
/// reads back, so it does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// let ld = r#"{"@type":"Product"}"#;
/// let head = html! { <script type="application/ld+json">{ld}</script> };
/// ```
#[cfg(feature = "json")]
pub struct JsonLd<'a, T: ?Sized> {
    /// The structured data.
    pub value: &'a T,
}

#[cfg(feature = "json")]
impl<T: crate::json::ToJson + ?Sized> Render for JsonLd<'_, T> {
    fn render(&self, out: &mut String) {
        let json = crate::json::to_vec(self.value);
        let json = std::str::from_utf8(&json).expect("ToJson writes UTF-8");
        out.push_str(r#"<script type="application/ld+json">"#);
        // `<` is only ever inside a JSON string, where `\u003c` reads the same.
        let mut parts = json.split('<');
        out.push_str(parts.next().unwrap_or(""));
        for part in parts {
            out.push_str("\\u003c");
            out.push_str(part);
        }
        out.push_str("</script>");
    }
}
/// A part of a document, for [`Req::render_into`].
struct Parted<D>(D, Part);

impl<D: Document> Render for Parted<D> {
    #[inline]
    fn render(&self, out: &mut String) {
        self.0.render_part(out, self.1)
    }
}

/// Under `corten dev`: an error when a full page has a `data-vars` value its style block has no
/// rule for, which markup placed with `raw` gives (its render's values were not noted), so a size
/// from data would paint at its initial value until a patch. Read tag by tag, so text inside another
/// attribute's value (a handler argument in `data-on`) is not taken for one.
#[cfg(debug_assertions)]
#[cold]
#[inline(never)]
fn unruled_vars(page: &str, rules: &str) -> Result<()> {
    use crate::html::{Event, Markup};

    let mut scripting = true;
    loop {
        let mut fallback = false;
        for event in Markup::new(page, true, scripting) {
            let Event::Start { tag, foreign, live, .. } = event else { continue };
            fallback |= scripting && !foreign && tag.name == "noscript";
            // Only the scripting-on pass checks templates that scripts can copy.
            if !scripting && !live {
                continue;
            }
            let Some(value) = tag.attr("data-vars") else { continue };
            if !rules.contains(&format!("[data-vars=\"{value}\"]")) {
                return Err(Error::corten(format!(
                    "the page has data-vars=\"{value}\" and no rule for it, so that size paints at its initial value: markup placed with raw() keeps no values; render the view into a corten::Rendered and place that"
                )));
            }
        }
        if !fallback {
            return Ok(());
        }
        // Without scripting, noscript has child markup and can change the parse after it too.
        scripting = false;
    }
}

/// An HTML answer, which varies as `vary` says: [`VARY`] for a patch, [`Req::vary`] for a page.
pub(crate) fn html_response(status: StatusCode, body: String, kind: Option<HeaderName>, vary: HeaderValue) -> Response {
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    let headers = res.headers_mut();
    // Room for the headers `App` adds too, so the map is allocated once: with HSTS a compressed
    // page holds 13 (its `ETag` included), which a map of 12 would grow for, an app error page 13
    // and the default error page 12. 13 makes 24 slots, which hold a header of the app's own too.
    // Measured when each held one more, the `Content-Length` the server now writes: fewer
    // instructions than 12 in every case, the ranges apart.
    headers.reserve(13);
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::VARY, vary);
    if let Some(kind) = kind {
        headers.insert(kind, HeaderValue::from_static("1"));
    }
    res
}

#[cfg(test)]
mod carried_tests {
    use super::*;

    /// `corten dev` reads a page's `data-vars` attributes, not text that looks like one inside
    /// another attribute's value: a handler argument in `data-on` keeps its JSON's quotes.
    #[cfg(debug_assertions)]
    #[test]
    fn a_data_vars_lookalike_inside_data_on_is_not_a_value() {
        let rules = r#"[data-vars="--m__fill:42.5%"]{--m__fill:42.5%!important}"#;
        let ruled = r#"<div data-vars="--m__fill:42.5%" data-on='connect:m.f($t,["a data-vars=","b"])'></div>"#;
        assert!(unruled_vars(ruled, rules).is_ok());
        let unruled = r#"<p data-on='connect:m.f($t," data-vars=")'></p><div data-vars="--m__fill:7%"></div>"#;
        let error = unruled_vars(unruled, rules).expect_err("7% has no rule").to_string();
        assert!(error.contains(r#"data-vars="--m__fill:7%" and no rule"#), "{error}");
        // Markup placed with raw() may have a `<` that starts no tag in its text: the tag after it
        // is still read.
        let raw = r#"<p>1 <2 <div data-vars="--m__fill:7%"></div></p>"#;
        let error = unruled_vars(raw, rules).expect_err("7% after a lone < has no rule").to_string();
        assert!(error.contains(r#"data-vars="--m__fill:7%" and no rule"#), "{error}");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn noscript_fallback_vars_need_rules() {
        let fallback = r#"<noscript><div data-vars="--m:7%">Fallback</div></noscript>"#;
        let error = unruled_vars(fallback, "").expect_err("the no-script div has no rule").to_string();
        assert!(error.contains(r#"data-vars="--m:7%" and no rule"#), "{error}");
        assert!(unruled_vars(fallback, r#"[data-vars="--m:7%"]{--m:7%!important}"#).is_ok());
        // In the other parse, this raw-text close ends noscript but leaves the div in a comment.
        let scripted = r#"<noscript><!--</noscript><div data-vars="--m:8%">Scripted</div>--></noscript>"#;
        let error = unruled_vars(scripted, "").expect_err("the scripting-on div has no rule").to_string();
        assert!(error.contains(r#"data-vars="--m:8%" and no rule"#), "{error}");
        let inert = r#"<template><noscript><span data-vars="--m:7%">Offline</span></noscript></template>"#;
        assert!(unruled_vars(inert, "").is_ok());
        let copy = r#"<template><span data-vars="--m:7%">Copy</span></template>"#;
        assert!(unruled_vars(copy, "").is_err());
        let shadow =
            r#"<div><template shadowrootmode=open><noscript><span data-vars="--m:7%">Offline</span></noscript></template></div>"#;
        assert!(unruled_vars(shadow, "").is_err());
    }

    /// The failed answer's `Vary` names are added to the error page's, each name once whatever its
    /// case or the line it is on, and a value that is not text as it came.
    #[test]
    fn a_kept_vary_name_is_added_once() {
        let mut kept = HeaderMap::new();
        kept.append(header::VARY, HeaderValue::from_static("Corten, Origin, origin"));
        kept.append(header::VARY, HeaderValue::from_static("cookie"));
        kept.append(header::VARY, HeaderValue::from_bytes(b"caf\xe9").unwrap());
        let mut res = Response::new(Body::empty());
        res.headers_mut().append(header::VARY, HeaderValue::from_static("corten, accept"));
        let res = carried(kept, crate::cache::Marks { unshared: false, no_store: false }, res);
        let vary: Vec<_> = res.headers().get_all(header::VARY).iter().map(HeaderValue::as_bytes).collect();
        assert_eq!(vary, [&b"corten, accept"[..], b"Origin", b"cookie", b"caf\xe9"]);
    }

    /// A runtime says it draws a write's own page whole as an HTTP preference (RFC 7240): the first
    /// `corten-draws` across every `Prefer` line, its name case aside, its value as written (a
    /// token or a quoted string), its parameters and other preferences aside (#1370).
    #[test]
    fn a_write_s_own_page_is_whole_for_a_runtime_that_prefers_it() {
        let whole = |lines: &[&'static str]| {
            let mut headers = HeaderMap::new();
            for line in lines {
                headers.append(PREFER, HeaderValue::from_static(line));
            }
            prefers_whole(&headers)
        };
        assert!(whole(&[DRAWS_WHOLE]));
        assert!(whole(&["respond-async, Corten-Draws = \"whole\"; seen=\"a;b\", wait=10"]));
        assert!(whole(&["return=minimal", "corten-draws=whole"]));
        assert!(!whole(&[]));
        assert!(!whole(&["corten-draws"]));
        assert!(!whole(&["corten-draws=WHOLE"]));
        assert!(!whole(&["corten-draws=main, corten-draws=whole"]));
        assert!(!whole(&["corten-draws=main", "corten-draws=whole"]));
        assert!(!whole(&[r#"note="x, corten-draws=whole""#]));
        assert!(!whole(&["corten-drawsx=whole"]));
        // Only a write the runtime sent, never a `GET` or `HEAD`.
        let mut headers = HeaderMap::new();
        headers.insert(PREFER, HeaderValue::from_static(DRAWS_WHOLE));
        assert!(own_page_whole(Mode::Action, &http::Method::POST, &headers));
        assert!(!own_page_whole(Mode::Action, &http::Method::GET, &headers));
        assert!(!own_page_whole(Mode::Action, &http::Method::HEAD, &headers));
        assert!(!own_page_whole(Mode::Document, &http::Method::POST, &headers));
    }

    #[test]
    fn a_request_s_mode_is_its_corten_header_s_or_its_first_accept_line_s() {
        /// A header's lines.
        type Lines = &'static [&'static [u8]];
        let read = |corten: Lines, accept: Lines, check_html| {
            let mut headers = HeaderMap::new();
            for (name, lines) in [(MODE_HEADER, corten), (header::ACCEPT, accept)] {
                for line in lines {
                    headers.append(name.clone(), HeaderValue::from_bytes(line).unwrap());
                }
            }
            let read = Mode::read(&headers, check_html);
            assert_eq!(Mode::asked(&headers), read.0);
            assert_eq!(Mode::of(&headers), read.0 .0);
            read
        };
        // The mode, whether the runtime sent the request, and whether a document was asked for by
        // an `Accept` that names HTML.
        let cases: [(Lines, Lines, Mode, bool, bool); 24] = [
            // No `corten`: the first item of the first `Accept` line, JSON or anything else.
            (&[], &[], Mode::Document, false, false),
            (&[], &[b"text/html,application/xhtml+xml,*/*;q=0.8"], Mode::Document, false, true),
            (&[], &[b"*/*"], Mode::Document, false, false),
            (&[], &[b"application/json"], Mode::Data, false, false),
            (&[], &[b" application/json ; q=0.9, text/html"], Mode::Data, false, false),
            (&[], &[b"text/html, application/json"], Mode::Document, false, true),
            (&[], &[b"application/jsonx, text/html"], Mode::Document, false, true),
            (&[], &[b"application/problem+json"], Mode::Document, false, false),
            (&[], &[b"text/html", b"application/json"], Mode::Document, false, true),
            (&[], &[b"application/json", b"text/html"], Mode::Data, false, false),
            // HTML is named or it is not, wherever in the line: another `text/` type at the start
            // is not HTML, and HTML after it is.
            (&[], &[b"text/plain"], Mode::Document, false, false),
            (&[], &[b"text/event-stream"], Mode::Document, false, false),
            (&[], &[b"text/plain, text/html;q=0.9"], Mode::Document, false, true),
            // One that is not text is read as none.
            (&[], &[b"application/json\xff"], Mode::Document, false, false),
            (&[], &[b"text/html\xff"], Mode::Document, false, false),
            (&[], &[b"text/html\xff", b"application/json"], Mode::Document, false, false),
            // The runtime's three, whatever `Accept` says, which is then not read.
            (&[b"nav"], &[b"application/json"], Mode::Navigation, true, false),
            (&[b"action"], &[b"text/html"], Mode::Action, true, false),
            (&[b"page"], &[b"text/html"], Mode::Document, true, false),
            (&[b"page"], &[b"application/json"], Mode::Document, true, false),
            (&[b"nav", b"page"], &[], Mode::Navigation, true, false),
            // Any other value names no mode, and the runtime did not send it.
            (&[b"another"], &[b"application/json"], Mode::Data, false, false),
            (&[b"NAV"], &[b"text/html"], Mode::Document, false, true),
            (&[b"another", b"nav"], &[b"text/html"], Mode::Document, false, true),
        ];
        for (corten, accept, mode, fetched, html) in cases {
            let text = |lines: &[&[u8]]| lines.iter().map(|line| line.escape_ascii().to_string()).collect::<Vec<_>>();
            let said = format!("corten {:?}, accept {:?}", text(corten), text(accept));
            assert_eq!(read(corten, accept, true), ((mode, fetched), html), "{said}");
            assert_eq!(read(corten, accept, false), ((mode, fetched), false), "{said}");
        }
    }

    /// `Mode::said` stops at the first item's start, and decides as reading that whole item does:
    /// its media type, cut at the first `;` and trimmed, is JSON. Every line made of these parts
    /// is decided both ways, and with a runtime's header, which `Accept` never overrides.
    #[test]
    fn the_first_accept_item_is_json_as_reading_the_whole_item_says() {
        let whole =
            |line: &str| crate::api::media_type(line.split(',').next().unwrap_or("")).eq_ignore_ascii_case(crate::api::JSON);
        let before = ["", " ", "\t", " \t "];
        let types = [
            "application/json",
            "application/jsonx",
            "application/json+x",
            "application/json/",
            "application/jso",
            "Application/JSON",
            "application/JSON",
            "APPLICATION/JSON",
            "Application/JSONx",
            "application/problem+json",
            "text/html",
            "*/*",
            "application/*",
            "",
        ];
        let after = ["", " ", "\t", " \t"];
        let then = ["", ",", ";", ";q=0", "; q=0.5", ", text/html", ",application/json", "x", " x", ";,", ",;"];
        let rest = ["", ", */*;q=0.8", ", application/json", "  "];
        let mut decided = [0; 2];
        for before in before {
            for ty in types {
                for after in after {
                    for then in then {
                        for rest in rest {
                            let line = format!("{before}{ty}{after}{then}{rest}");
                            let value = HeaderValue::from_str(&line).unwrap();
                            let ((mode, fetched), accept) = Mode::said(None, || Some(&value));
                            assert_eq!(mode == Mode::Data, whole(&line), "{line:?}");
                            assert_eq!((fetched, accept), (false, line.as_str()), "{line:?}");
                            decided[usize::from(mode == Mode::Data)] += 1;
                            for runtime in ["nav", "action", "page"] {
                                let runtime = HeaderValue::from_static(runtime);
                                let ((mode, fetched), accept) = Mode::said(Some(&runtime), || Some(&value));
                                assert!(mode != Mode::Data && fetched && accept.is_empty(), "{line:?}");
                            }
                        }
                    }
                }
            }
        }
        // Both answers are among the lines, so neither reading is the same for all of them.
        assert!(decided.iter().all(|&n| n > 100), "{decided:?}");
        // The quoted comma follows the semicolon, so neither reading lets it affect the media type.
        for line in
            [r#"application/json; p="a,b", text/html"#, r#"text/html; p="a,b", application/json"#, r#"application/json;p="a,b""#]
        {
            let value = HeaderValue::from_static(line);
            let ((mode, _), _) = Mode::said(None, || Some(&value));
            assert_eq!(mode == Mode::Data, whole(line), "{line:?}");
        }
        // No line, and one that is not text, are no JSON.
        assert_eq!(Mode::said(None, || None).0, (Mode::Document, false));
        // Even bytes after the item's media type invalidate the entire line.
        for line in [&b"application/json\xff"[..], b"application/json; q=\xff", b"application/json, text/\xff"] {
            let not_text = HeaderValue::from_bytes(line).unwrap();
            assert_eq!(Mode::said(None, || Some(&not_text)), ((Mode::Document, false), ""));
        }
    }
}
