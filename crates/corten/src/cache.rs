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
//!   from the same URL as the page), only the browser keeps it (`private`, same lifetime), so a
//!   cache that ignores `Vary` cannot hand one form to another client. An [`crate::App::api`]
//!   route has one form only, so it may be shared;
//! - a response that keeps a lifetime also varies on `cookie`: after the user signs in or out,
//!   the browser fetches the page again instead of reusing the other one.
//!
//! Some things are never shared, whoever set the header (`Public`, or a `Cache-Control` written by
//! hand, by a middleware or on an [`crate::HtmlResponse`]): a response that sets a cookie, HTML
//! with this request's CSP nonce (`req.nonce()` in the layout, or a handler that takes
//! [`crate::security::Nonce`]), and an answer to a request whose handler or middleware read a
//! [`crate::Caller`]. They get `private, no-cache`, and `corten dev` logs the first two.
//!
//! A `Public` handler cannot read a cookie or a header through an extractor of the app's own unless
//! the app marks it [`crate::answer::Anonymous`]. A `Cache-Control` written by hand is the app's
//! own choice apart from the rules above. A cache in front must key on `Vary` (`corten`, `accept`,
//! `accept-encoding`, `cookie` on an answer to a request without one, and `accept-language` with
//! [`crate::App::messages`] unless the handler took the locale from the URL,
//! [`crate::Req::set_locale`]); the deploy guide names the setting for nginx, Cloudflare and CloudFront.

use std::time::Duration;

use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponseParts, Response, ResponseParts},
};

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
        HeaderValue::from_maybe_shared(axum::body::Bytes::from(text)).expect("digits are a valid header")
    }
}

impl Cache {
    /// Sets the response's `Cache-Control` to this, as [`settle`] reads it.
    pub(crate) fn apply(self, res: &mut Response) {
        res.headers_mut().insert(header::CACHE_CONTROL, self.header());
        res.extensions_mut().insert(Typed);
        if self.kind == Kind::Immutable {
            res.extensions_mut().insert(Named);
        }
    }
}

impl IntoResponseParts for Cache {
    type Error = std::convert::Infallible;

    fn into_response_parts(self, mut res: ResponseParts) -> Result<ResponseParts, Self::Error> {
        res.headers_mut().insert(header::CACHE_CONTROL, self.header());
        res.extensions_mut().insert(Typed);
        Ok(res)
    }
}

/// Marks a `Cache-Control` that came from [`Cache`], which [`settle`] checks against the request.
#[derive(Clone, Copy)]
struct Typed;

/// Marks a [`Cache::immutable`] answer: its URL names it, so the request's cookies do not change it.
#[derive(Clone, Copy)]
struct Named;

/// The default for what the app renders.
pub(crate) const PRIVATE: HeaderValue = HeaderValue::from_static("private, no-cache");

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

/// True when the request carries credentials: `Authorization`, or a cookie other than the time
/// zone the runtime keeps for [`crate::App::client_zone`], which says nothing about who is asking.
pub(crate) fn credentials(headers: &HeaderMap) -> bool {
    // One lookup for a request with a session cookie, as `contains_key` was; `get_all` cost about
    // 190 instructions more (callgrind).
    match headers.get(header::COOKIE) {
        None => headers.contains_key(header::AUTHORIZATION),
        Some(cookie) if !zone_only(cookie) => true,
        Some(_) => headers.get_all(header::COOKIE).iter().nth(1).is_some() || headers.contains_key(header::AUTHORIZATION),
    }
}

/// A `Cookie` header with only [`crate::App::client_zone`]'s cookie in it.
fn zone_only(cookie: &HeaderValue) -> bool {
    let cookie = cookie.as_bytes();
    cookie.starts_with(b"corten-zone=") && !cookie.contains(&b';')
}

/// Corten's removal of a redirect's notice, on the page it was for (either cookie it rides in): that
/// page is private, by the request's cookie, but not the app's mistake.
const NOTICE_GONE: [&[u8]; 2] = [b"__Host-corten-notice=;", b"corten-notice=;"];

/// Sets the response's `Cache-Control`: the default when it has none, and a private one instead
/// of a shared one when the response may differ between users.
pub(crate) fn settle(res: &mut Response, seen: Seen, path: &str) {
    // One lookup for the usual response, which says nothing.
    // `personal`: what an answer that may differ between users is sent instead of a header that
    // would let a cache keep it.
    let (text, personal) = match res.headers_mut().entry(header::CACHE_CONTROL) {
        header::Entry::Vacant(entry) => {
            entry.insert(PRIVATE);
            return;
        }
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
                if quoted || !text {
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
            // A personal answer whose header is replaced below gets `no-store` if any reader
            // could find one in it (`no-store=1`, inside a quoted value, with `must-understand`):
            // stricter than `private, no-cache` for every reading.
            let personal = if entry.iter().any(|line| mentions_no_store(line.as_bytes())) { NO_STORE } else { PRIVATE };
            (entry.get().to_str().unwrap_or("").to_string(), personal)
        }
    };
    let typed = res.extensions().get::<Typed>().is_some();
    let headers = res.headers_mut();
    let bug = if seen.nonce {
        Some("its HTML has this request's CSP nonce (req.nonce() in the layout, or a handler that takes Nonce)")
    } else if headers
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|cookie| !NOTICE_GONE.iter().any(|gone| cookie.as_bytes().starts_with(gone)))
    {
        Some("it sets a cookie")
    } else {
        None
    };
    if let Some(bug) = bug {
        if seen.dev {
            tracing::warn!("corten: {path} is marked for shared caches, but {bug}, so it was sent private, no-cache (or no-store, if its header names it)");
        }
        headers.insert(header::CACHE_CONTROL, personal);
        return;
    }
    let named = res.extensions().get::<Named>().is_some();
    let headers = res.headers_mut();
    if seen.caller || (typed && seen.credentials && !named) {
        headers.insert(header::CACHE_CONTROL, personal);
        return;
    }
    if !typed {
        return;
    }
    if seen.partial {
        headers.insert(header::CACHE_CONTROL, private(&text));
    }
    if !named {
        headers.append(header::VARY, HeaderValue::from_static("cookie"));
    }
}

/// The key a page's tag is made with ([`tag`]): random for each process, so nobody outside it can
/// make two bodies share a tag.
static TAG_KEY: std::sync::LazyLock<std::hash::RandomState> = std::sync::LazyLock::new(std::hash::RandomState::new);

/// Marks a page whose body holds a value drawn for this request alone (a [`crate::SubmitKey`]'s
/// new key): its tag would never match, so it is not made.
#[derive(Clone, Copy)]
pub(crate) struct Unrepeatable;

/// A page's `200` to a `GET` or `HEAD` with a weak `ETag` from its body and its `corten-*`
/// headers, or `304 Not Modified` in its place when the request's `If-None-Match` (`has`, each
/// line) names that tag. The tag is made from what this request rendered, so a `304` says the
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
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return Response::from_parts(parts, Body::empty());
    };
    let tag = weak_tag(&bytes, &parts.headers);
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

/// A `304`'s empty body, of no stated size: axum writes `Content-Length` for a body that states one,
/// and a `304`'s may only be the `200`'s (RFC 9110 8.6), which compression has not decided.
struct Unsized;

impl http_body::Body for Unsized {
    type Data = axum::body::Bytes;
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
fn weak_tag(body: &[u8], headers: &HeaderMap) -> [u8; 20] {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = TAG_KEY.build_hasher();
    // Its length first, so no body and headers read as another body and fewer headers.
    hasher.write_usize(body.len());
    hasher.write(body);
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
fn names(line: &[u8], opaque: &[u8]) -> bool {
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
    let mut quoted = false;
    let mut escaped = false;
    line.split(move |&b| {
        if escaped {
            escaped = false;
        } else if quoted && b == b'\\' {
            escaped = true;
        } else if b == b'"' {
            quoted = !quoted;
        } else if b == b',' && !quoted {
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
    use axum::response::IntoResponse;

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
            res.extensions_mut().insert(Typed);
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
