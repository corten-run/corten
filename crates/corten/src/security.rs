//! Browser security defaults: a Content-Security-Policy with a fresh nonce per request, the usual
//! hardening headers, a same-origin check for writes (CSRF), and session cookie helpers.
//!
//! ```ignore
//! let app = App::new(routes).policy(corten::security::Policy::new().script_src("https://js.stripe.com"));
//! ```
//!
//! Corten's own inline tag (the import map) is the same on every page of a deploy, so the CSP
//! allows it by its SHA-256 hash. [`crate::Req::nonce`] gives the layout a nonce for any
//! inline script the app adds. Nothing else inline runs, so an HTML injection cannot execute
//! script even if a template escapes wrongly.
//!
//! The nonce is made the first time something asks for it (the layout, or a handler that takes
//! [`Nonce`]). A response nothing asked for (most pages, JSON, a patch, a static file) gets the
//! policy without a nonce source: it allows less, costs no random bytes, and the same page is the
//! same bytes for every request, so a cache may share it ([`crate::App`], caching).

use std::{
    cell::RefCell,
    convert::Infallible,
    sync::{Arc, OnceLock},
};

use crate::{
    extract::FromRequestParts,
    handler::Request,
    response::{IntoResponse, Response},
};
use http::{header, request::Parts, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};

#[cfg(feature = "json")]
mod violations;
#[cfg(feature = "json")]
pub use violations::{Violation, Violations};

/// What [`Policy::report_to`] takes: a route of the app's with a `post` (or `any`) handler, in a
/// `#[corten::routes]` module without `caller =`, or a `corten::http::Uri` of a collector
/// elsewhere. A handler that takes a `Caller` itself, or middleware that refuses a request
/// without a session, is not seen here: a browser posts a report without the visitor's session.
#[diagnostic::on_unimplemented(
    message = "{Self} is not a route reports can be posted to",
    label = "not a route with a `post` handler in a #[corten::routes] module without `caller =`",
    note = "reports go to a route with a post handler in a routes module that requires no caller, #[route(\"/csp-reports\", post = csp_reports)], or to a collector elsewhere, &Uri::from_static(\"https://csp.example.com/r\")"
)]
pub trait ReportTo: crate::route::Href + report_to::Sealed {
    /// Whether this is one of the app's routes, whose link is a path.
    #[doc(hidden)]
    fn route(&self) -> bool;
}

mod report_to {
    pub trait Sealed {}
}

impl<R: crate::Route + crate::route::__private::Posts + ?Sized> report_to::Sealed for R {}

impl<R: crate::Route + crate::route::__private::Posts + ?Sized> ReportTo for R {
    fn route(&self) -> bool {
        true
    }
}

impl report_to::Sealed for http::Uri {}

impl ReportTo for http::Uri {
    fn route(&self) -> bool {
        false
    }
}

/// The CSP nonce for this request: `req.nonce()` in a layout, or `nonce: Nonce` as an
/// extractor in a handler that writes HTML itself. Asking for it is what puts it in the
/// response's CSP.
#[derive(Clone, Debug)]
pub struct Nonce(pub Arc<str>);

impl<S: Send + Sync> FromRequestParts<S> for Nonce {
    type Rejection = Infallible;

    /// Without a [`Policy`] nothing checks a nonce, so any fresh one is as good.
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(parts.extensions.get::<NonceSlot>().map_or_else(Nonce::generate, |slot| slot.get().clone()))
    }
}

/// Where the request's nonce is made, at most once, when something asks for it. A page's request
/// has one; it also carries what the page's area policy adds to its shell key, found with its CSP,
/// and whether that CSP lets scripts load from other origins ([`Sources::script_loads`]).
#[derive(Clone, Default)]
pub(crate) struct NonceSlot(Arc<OnceLock<Nonce>>, pub(crate) u64, pub(crate) bool);

impl NonceSlot {
    /// A page's slot, with what its area's policy adds to its shell key (0 for the app's), and
    /// whether its policy lets scripts load from other origins.
    pub fn new(shell: u64, script_loads: bool) -> Self {
        NonceSlot(Arc::default(), shell, script_loads)
    }

    pub fn get(&self) -> &Nonce {
        self.0.get_or_init(Nonce::generate)
    }

    pub fn taken(&self) -> Option<&Nonce> {
        self.0.get()
    }
}

impl Nonce {
    /// 128 random bits from the operating system, hex encoded (hex is valid base64 text).
    pub fn generate() -> Self {
        Nonce(std::str::from_utf8(&random_hex()).expect("hex is ASCII").into())
    }
}

/// 128 random bits from the operating system as 32 lowercase hex digits.
pub(crate) fn random_hex() -> [u8; 32] {
    // One system call per 64 nonces: each thread reads 1 KiB of OS randomness and hands it out
    // 16 bytes at a time, never twice. The bytes are as unpredictable as a fresh read.
    thread_local! {
        static POOL: RefCell<([u8; 1024], usize)> = const { RefCell::new(([0; 1024], 1024)) };
    }
    let bytes: [u8; 16] = POOL.with_borrow_mut(|(pool, used)| {
        if *used == pool.len() {
            getrandom::fill(pool).expect("the OS random source is available");
            *used = 0;
        }
        let bytes = pool[*used..*used + 16].try_into().expect("16 bytes");
        pool[*used..*used + 16].fill(0);
        *used += 16;
        bytes
    });
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = [0u8; 32];
    for (i, b) in bytes.iter().enumerate() {
        text[2 * i] = HEX[(b >> 4) as usize];
        text[2 * i + 1] = HEX[(b & 15) as usize];
    }
    text
}

/// Security policy for every response of a router (an area's pages add to it:
/// [`crate::Area::policy`]). Build it once at startup.
#[derive(Clone, Debug)]
pub struct Policy {
    sources: Sources,
    hsts: bool,
    allowed_origins: Vec<String>,
    report_only: bool,
    /// `Reporting-Endpoints`'s value naming where CSP reports go (`csp="/csp-reports"`), set by
    /// [`Policy::report_to`]; the CSP then names the endpoint (`report-to csp`).
    reporting: Option<HeaderValue>,
    /// The names the app answers to besides `localhost` and IP addresses; `None`: any.
    hosts: Option<Vec<String>>,
    /// The proxies whose `X-Forwarded-For` [`crate::ClientIp`] follows.
    proxies: Vec<crate::client::Network>,
}

impl Default for Policy {
    fn default() -> Self {
        Self::new()
    }
}

impl Policy {
    /// Same-origin everything, `https:` and `data:` images, no frames, no plugins.
    pub fn new() -> Self {
        Policy {
            sources: Sources { img: vec!["data:".into(), "https:".into()], ..Sources::default() },
            hsts: false,
            allowed_origins: Vec::new(),
            report_only: false,
            reporting: None,
            hosts: Some(Vec::new()),
            proxies: Vec::new(),
        }
    }

    /// Another origin scripts may load from (a payment SDK, for example). One only some pages
    /// need is their area's ([`crate::Area::policy`]). A script on those pages may load one from
    /// it the usual way, `script.src = "https://js.stripe.com/.."`, and so may the scripts it
    /// loads: where a source names a host (not a keyword or a scheme alone, such as `https:`),
    /// the pages allow a `default` Trusted Types policy, made by a script at `<Corten />` before
    /// any after it runs, that passes an http or https URL on another origin and nothing else (no
    /// URL on this origin, no markup, no script text); the CSP then holds the load to the sources
    /// listed here, so a broad one (`https://*.example.com`) lets in what it names. Pages that
    /// allow `default` by name ([`Policy::trusted_types_policy`]) have the app's own instead, and
    /// pages whose `script_src` has `'strict-dynamic'` (which ignores the hosts listed) have none.
    pub fn script_src(mut self, source: &str) -> Self {
        self.sources = self.sources.script_src(source);
        self
    }

    pub fn style_src(mut self, source: &str) -> Self {
        self.sources = self.sources.style_src(source);
        self
    }

    pub fn img_src(mut self, source: &str) -> Self {
        self.sources = self.sources.img_src(source);
        self
    }

    /// Another origin `fetch` and `EventSource` may reach.
    pub fn connect_src(mut self, source: &str) -> Self {
        self.sources = self.sources.connect_src(source);
        self
    }

    /// An origin the page may embed in an `<iframe>` (payment fields, for example).
    pub fn frame_src(mut self, source: &str) -> Self {
        self.sources = self.sources.frame_src(source);
        self
    }

    pub fn font_src(mut self, source: &str) -> Self {
        self.sources = self.sources.font_src(source);
        self
    }

    /// An origin that may show these pages in an `<iframe>` (`frame-ancestors`), which no site may
    /// by default. Allowed here, every page may be framed there; one part of the app's pages (a
    /// widget partners embed) is its area's ([`Sources::frame_ancestors`]). A source is a host or
    /// a scheme, or `'self'` for the app's own pages; a framed page is sent no `X-Frame-Options`,
    /// or `SAMEORIGIN` when `'self'` is its only one.
    pub fn frame_ancestors(mut self, source: &str) -> Self {
        self.sources = self.sources.frame_ancestors(source);
        self
    }

    /// Another origin a form may send the user to (`form-action`): a hosted checkout, an identity
    /// provider's `form_post`, a sibling app. It also allows a form's handler to redirect there
    /// (`req.redirect(&uri)`), since Chromium and WebKit apply `form-action` to the redirects a
    /// submission follows. Without it a form goes to this origin only. A form posted straight to
    /// another app also needs that app to accept posts from this origin (most frameworks refuse a
    /// cross-origin post as CSRF), so posting here and redirecting is usually simpler. Writes
    /// coming in from another site are [`Policy::allow_origin`]. A debug build answers a write
    /// from one of the app's pages that redirects to an origin its page does not allow as an error
    /// naming it, so a test sees what a browser would stop. A redirect after the write's own (the
    /// page it goes to sending someone to sign in elsewhere) is held to the same policy by the
    /// browser and is not checked.
    pub fn form_action(mut self, source: &str) -> Self {
        self.sources = self.sources.form_action(source);
        self
    }

    /// Allows `style="..."` attributes in markup. Off by default; setting `element.style` from
    /// script is always allowed. A size drawn from data needs none: it is a custom property set
    /// from markup ([`crate::style::Var`]). Pages that show rich text written with style attributes
    /// in one part of the app allow them there only ([`crate::Area::policy`]).
    pub fn allow_style_attributes(mut self) -> Self {
        self.sources = self.sources.allow_style_attributes();
        self
    }

    /// Lets a script on these pages create a Trusted Types policy of this name. Pages require
    /// Trusted Types (`require-trusted-types-for 'script'`), so markup reaches the DOM from a
    /// string (`innerHTML`, `insertAdjacentHTML`, `DOMParser`) only through a policy, and only the
    /// runtime's own (`corten`) may be created: what it lets through is the server's answers to
    /// the runtime's requests. A third-party script that makes its own policy (a payment SDK, a
    /// sanitizer) needs its name allowed, on its area's pages only ([`crate::Area::policy`]); one
    /// that writes markup from strings with no policy works once the app's own script creates a
    /// `default` policy for it, which needs `"default"` here. A script loaded from another
    /// origin needs none of this ([`Policy::script_src`]), unless the app makes `default` itself.
    pub fn trusted_types_policy(mut self, name: &str) -> Self {
        self.sources = self.sources.trusted_types_policy(name);
        self
    }

    /// A powerful feature every page may use, which `Permissions-Policy` otherwise denies to the
    /// page and the frames in it ([`Feature`]). One only some pages need is their area's
    /// ([`Sources::allow_feature`]).
    pub fn allow_feature(mut self, feature: Feature) -> Self {
        self.sources = self.sources.allow_feature(feature);
        self
    }

    /// Says the app is served only over HTTPS. It sends `Strict-Transport-Security` (one year,
    /// subdomains); a write or a WebSocket handshake with no `Sec-Fetch-Site` must come from an
    /// `https` page on the request's host (or a loopback one, which browsers count as secure),
    /// so a plain-http page there is refused as another site's ([`Policy::same_origin`]); and a
    /// redirect's notice always rides in the `__Host-` cookie. Set it whenever the app is served
    /// only over HTTPS, even when a proxy or CDN in front already sends the header: without it the
    /// app cannot tell which scheme it is served over, and that check does not compare the scheme.
    pub fn hsts(mut self) -> Self {
        self.hsts = true;
        self
    }

    /// Another origin allowed to send writes with the user's cookies (`https://admin.example.com`):
    /// a scheme, a host (an ASCII name, an IPv4 address or a bracketed IPv6 one) and a port
    /// when it is not the scheme's default. A write is let through when its `Origin` is this
    /// origin as a browser writes it there (RFC 6454): the scheme and host lowercase, and a
    /// default port (`:443` for `https`, `:80` for `http`) and a trailing `/` left out, so
    /// `https://Admin.example.com:443/` is `https://admin.example.com`. Another scheme is the
    /// origin an app's webview or a browser extension sends, like `capacitor://localhost` or
    /// `chrome-extension://<id>`, kept with any port it has
    /// (docs/design.md#choice-allowed-origin-schemes).
    /// Anything else, which no `Origin` could ever equal (no scheme, a path, a query, a user,
    /// a wildcard, a list, `null`, or a scheme no page sends from: `file`, `data`, `blob`,
    /// `javascript`, `about`, `ws`, `wss`, `ftp`), is a startup panic, and a name outside ASCII
    /// is one that says to write it in its `xn--` form:
    ///
    /// ```should_panic
    /// corten::security::Policy::new().allow_origin("https://*.example.com");
    /// ```
    pub fn allow_origin(mut self, origin: &str) -> Self {
        self.allowed_origins.push(allowed_origin("Policy::allow_origin", origin));
        self
    }

    /// Lets popups this site opens keep `window.opener` (`Cross-Origin-Opener-Policy:
    /// same-origin-allow-popups`), for sign-in or payment flows that report back from a popup.
    /// Without it the policy is `same-origin`. One part of the app only: [`Sources::allow_popups`].
    pub fn allow_popups(mut self) -> Self {
        self.sources = self.sources.allow_popups();
        self
    }

    /// A stricter `Referrer-Policy` for every answer than `strict-origin-when-cross-origin`; one
    /// part of the app only: [`Sources::referrer`].
    pub fn referrer(mut self, referrer: Referrer) -> Self {
        self.sources = self.sources.referrer(referrer);
        self
    }

    /// Sends `Cross-Origin-Opener-Policy: unsafe-none` (the browser's default): another site's
    /// window this page opens, or that opened it, can still reach it. This is for an embed whose
    /// sign-in runs in a popup on the provider's origin that talks back to the page, such as
    /// Stripe's Connect embedded components, which `same-origin` and `same-origin-allow-popups`
    /// break. It gives up the page's isolation from other sites' windows: one that opened it, or
    /// that it opens, keeps a reference to it (it can navigate it, `postMessage` it, see when it
    /// closes and count its frames, which cross-site leak attacks use to learn about a signed-in
    /// user), and the browser may run them in one process. Allow it on the pages that embed such
    /// a thing only ([`Sources::allow_cross_origin_opener`] in their area), not the whole app.
    pub fn allow_cross_origin_opener(mut self) -> Self {
        self.sources = self.sources.allow_cross_origin_opener();
        self
    }

    /// A name the app answers to (`shop.example`; `.shop.example` for it and every subdomain).
    /// By default a request is answered only when its `Host` is `localhost` (or a name under
    /// it), an IP address or missing; any other gets `421 Misdirected Request` before routing.
    /// (A request with two `Host` lines or one that is no host at all, or an HTTP/1.1 request
    /// the server read with none, is not one HTTP allows, and gets `400 Bad Request` whatever
    /// names the app has.)
    /// Otherwise a page on a name someone else controls could point that name at this machine
    /// (DNS rebinding) and use every route as if it were the app's own origin, the same-origin
    /// check included, which matters most for an app on loopback, where "only this machine can
    /// reach it" is the whole access model. A deployed app lists the names it is served under
    /// (behind a proxy that rewrites `Host`, the name the proxy sends). A name with a port, a
    /// scheme or a path is a startup panic:
    ///
    /// ```should_panic
    /// corten::security::Policy::new().host("https://shop.example");
    /// ```
    pub fn host(mut self, name: &str) -> Self {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        let bare = name.strip_prefix('.').unwrap_or(&name);
        assert!(
            !bare.is_empty() && bare.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.'),
            "corten: Policy::host takes a name (shop.example, or .shop.example for its subdomains too), not {name:?}"
        );
        if let Some(hosts) = &mut self.hosts {
            hosts.push(name);
        }
        self
    }

    /// Answers whatever host a request asks for, for an app whose names are not known in advance
    /// (one served under each customer's own domain) and that checks them itself. See
    /// [`Policy::host`] for what this gives up. A request HTTP does not allow is still a `400`.
    pub fn any_host(mut self) -> Self {
        self.hosts = None;
        self
    }

    /// What the request's target and `Host` say of it ([`Asked`]): one HTTP does not allow, one
    /// for another host, or one for the app, whose hosts are `localhost` or a name under it, an
    /// IP address, a name given to [`Policy::host`], or none at all (HTTP/1.0; a test's request).
    pub(crate) fn asked(&self, req: &Request, origin: &mut Origin<'_>) -> Asked {
        asked(req, || origin.host_lines(), self.hosts.as_deref())
    }

    /// The same check apart from the policy, for the routes that say `unstaged`.
    pub(crate) fn host_check(&self) -> HostCheck {
        HostCheck(self.hosts.as_deref().map(Arc::from))
    }

    /// A proxy in front of the app (`10.0.0.5`), or a network of them (`10.0.0.0/8`, `fc00::/7`),
    /// whose `X-Forwarded-For` [`ClientIp`](crate::ClientIp) follows back to the client. Without
    /// one the client is the connection's peer, and the header is not read: anyone can write it.
    /// List only the addresses requests come from when they come through the proxy: a client
    /// that can reach the app from a listed address can name any address it likes. A deploy sets
    /// `PROXIES` (comma separated) where it sets `HOST` and `PORT`. Anything but an address or a
    /// network, or a network with host bits set, is a startup panic:
    ///
    /// ```should_panic
    /// corten::security::Policy::new().proxy("10.0.0.1/8");
    /// ```
    pub fn proxy(mut self, network: &str) -> Self {
        let parsed = crate::client::Network::parse(network.trim());
        let Some(parsed) = parsed else {
            panic!("corten: Policy::proxy takes an address (10.0.0.5) or a network (10.0.0.0/8) with no host bits set, not {network:?}")
        };
        self.proxies.push(parsed);
        self
    }

    /// The proxies [`Policy::proxy`] trusts.
    pub(crate) fn proxies(&self) -> &[crate::client::Network] {
        &self.proxies
    }

    /// Sends the CSP as `Content-Security-Policy-Report-Only`, to try a policy on a live site.
    /// `Permissions-Policy` ([`Feature`]) is still enforced, and so is who may frame a page: by
    /// `X-Frame-Options`, or by an enforced `Content-Security-Policy` of its `frame-ancestors`
    /// alone for a page another origin may frame ([`Policy::frame_ancestors`]) and beside an
    /// enforced policy a relayed upstream brought.
    pub fn report_only(mut self) -> Self {
        self.report_only = true;
        self
    }

    /// Where the browser sends a report of each thing the CSP blocks, or with
    /// [`Policy::report_only`] would block: a route of the app's with a `post` handler, which takes
    /// `Violations` (feature `json`) to read the shapes browsers send alike, or a collector
    /// elsewhere, an `https://` URL (a `corten::http::Uri`). Every page's CSP, its areas' too, names
    /// it (`report-to csp`), and a full document is sent `Reporting-Endpoints` with its URL, so a
    /// change tried on a live site, or a script a policy blocks (a third-party script writing
    /// markup, which Trusted Types refuses), reaches the app instead of only each visitor's
    /// console. Browsers send reports to a secure origin only (`https:`, or `localhost` in
    /// development); Firefox batches them for about a minute, WebKit sends each at once.
    ///
    /// A route without a `post` handler, or one in a module with `caller =` (a browser sends a
    /// report without the visitor's session), does not compile, since every report would be
    /// refused without a word. A handler that takes a `Caller` itself is not seen, so the route's
    /// handler reads only `Violations`:
    ///
    /// ```compile_fail,E0277
    /// use corten::{prelude::*, security::Policy};
    ///
    /// #[corten::routes]
    /// mod url {
    ///     #[route("/csp-reports", get = reports)]
    ///     pub struct CspReports;
    /// }
    ///
    /// async fn reports() -> &'static str {
    ///     ""
    /// }
    ///
    /// let policy = Policy::new().report_to(&url::CspReports);
    /// ```
    ///
    /// Nor does a route in a module that requires a caller:
    ///
    /// ```compile_fail,E0277
    /// use corten::{http::request::Parts, prelude::*, security::{Policy, Violations}};
    ///
    /// #[derive(Clone, Hash)]
    /// struct Staff;
    ///
    /// impl<S: Sync> Identify<S> for Staff {
    ///     async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
    ///         Err(Refused::unauthorized(Challenge::bearer("staff")))
    ///     }
    /// }
    ///
    /// #[corten::routes(caller = Staff)]
    /// mod url {
    ///     #[route("/csp-reports", post = reports)]
    ///     pub struct CspReports;
    /// }
    ///
    /// async fn reports(_: Caller<Staff>, _: Violations) -> &'static str {
    ///     ""
    /// }
    ///
    /// let policy = Policy::new().report_to(&url::CspReports);
    /// ```
    ///
    /// Panics at startup on a URL a browser would drop without a word: `http:` to a host other
    /// than `localhost` or a loopback address, a URL with a user (`user@host`), or a path, which
    /// is the app's route instead.
    pub fn report_to(mut self, endpoint: &(impl ReportTo + ?Sized)) -> Self {
        let url = crate::route::link(endpoint);
        // A loopback host, which a browser treats as secure over `http:`.
        let loopback = |host: &str| {
            let name = host.to_ascii_lowercase();
            name == "localhost"
                || name.ends_with(".localhost")
                || host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
        };
        let ok = match url.parse::<http::Uri>() {
            Ok(uri) => match (uri.scheme_str(), uri.authority()) {
                // A route's path; a `Uri` is one elsewhere, with a scheme and a host.
                (None, None) => endpoint.route() && url.starts_with('/') && !url.starts_with("//"),
                // No `user@`: it would be published in every page's header, and hides the host.
                (Some(scheme), Some(authority)) if !authority.as_str().contains('@') && !authority.host().is_empty() => {
                    scheme == "https" || (scheme == "http" && loopback(authority.host()))
                }
                _ => false,
            },
            Err(_) => false,
        };
        // A URL's path may hold `"`, `\` or non-ASCII, which would break the header's quoted string,
        // and a browser drops a header it cannot read, the app's own endpoints with it.
        assert!(
            ok && url.bytes().all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\'),
            "Policy::report_to({url:?}): a browser sends reports to an https:// URL, http://localhost, or a route of this app's"
        );
        self.reporting = Some(HeaderValue::try_from(format!("csp=\"{url}\"")).expect("checked as visible ASCII"));
        self
    }

    /// The CSP header value for one nonce.
    pub fn csp(&self, nonce: &str) -> String {
        self.csp_with(Some(nonce), &crate::import_map(None, None, &[]))
    }

    /// The CSP, with `'nonce-...'` sources only when there is a nonce. `import_map` is the text of
    /// the page's import map, allowed by its hash.
    fn csp_with(&self, nonce: Option<&str>, import_map: &str) -> String {
        let list = |extra: &[String]| extra.iter().fold(String::new(), |acc, s| acc + " " + s);
        let nonce = nonce.map_or_else(String::new, |n| format!(" 'nonce-{n}'"));
        let import_map = hash_source(import_map);
        let s = &self.sources;
        let mut csp = format!(
            "default-src 'self'; script-src 'self' {import_map}{}{nonce}{}; style-src 'self'{nonce}{}; img-src 'self'{}; \
             connect-src 'self'{}; font-src 'self'{}; frame-src {}; object-src 'none'; base-uri 'self'; form-action 'self'{}; \
             frame-ancestors {}; worker-src 'self'; manifest-src 'self'; require-trusted-types-for 'script'; \
             trusted-types corten{}{}",
            if s.script_loads() { format!(" {}", hash_source(SCRIPT_LOADS)) } else { String::new() },
            list(&s.script),
            list(&s.style),
            list(&s.img),
            list(&s.connect),
            list(&s.font),
            if s.frame.is_empty() { "'none'".to_string() } else { list(&s.frame).trim_start().to_string() },
            list(&s.form_action),
            if s.ancestors.is_empty() { "'none'".to_string() } else { list(&s.ancestors).trim_start().to_string() },
            list(&s.trusted_types),
            if s.script_loads() { " default" } else { "" },
        );
        if s.style_attributes {
            csp.push_str("; style-src-attr 'unsafe-inline'");
        }
        if self.reporting.is_some() {
            csp.push_str("; report-to csp");
        }
        csp
    }
}

/// What a part of the app adds to its [`Policy`] for its pages, given to
/// [`crate::Area::policy`]: `.policy(|p| p.script_src("https://js.stripe.com"))`. Each source is
/// one the [`Policy`] method of the same name adds for every page; only adding is possible, so
/// an area never allows less than the app. The one exception goes the other way:
/// [`Sources::referrer`] only makes the area send less.
#[derive(Clone, Debug, Default)]
pub struct Sources {
    script: Vec<String>,
    style: Vec<String>,
    img: Vec<String>,
    connect: Vec<String>,
    frame: Vec<String>,
    font: Vec<String>,
    form_action: Vec<String>,
    /// The origins that may frame these pages (`frame-ancestors`); none: no one.
    ancestors: Vec<String>,
    /// Trusted Types policies a script may create besides the runtime's.
    trusted_types: Vec<String>,
    /// The [`Feature`]s these pages may use, one bit each ([`Feature::bit`]).
    features: u32,
    style_attributes: bool,
    opener: Opener,
    referrer: Sent,
}

/// A stricter `Referrer-Policy` than Corten's `strict-origin-when-cross-origin`, for pages whose
/// address must not reach other sites or the app's own logs (an OAuth consent, a password reset,
/// an invitation, a magic link): [`Sources::referrer`] for an area, [`Policy::referrer`] for the
/// app. There is no weaker value, so no part of the app can send more than the default does:
///
/// ```compile_fail,E0599
/// use corten::security::{Policy, Referrer};
/// let _ = Policy::new().referrer(Referrer::UnsafeUrl);
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Referrer {
    /// `strict-origin`: only the origin, to this site and to others (over HTTPS).
    StrictOrigin,
    /// `same-origin`: the whole address to this site, nothing to others.
    SameOrigin,
    /// `no-referrer`: nothing, to anyone.
    NoReferrer,
}

/// How much of the address a policy sends, from nothing: what an area asks for is the least of
/// each, so it can only send less.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Part {
    Nothing,
    Origin,
    Address,
}

/// What a `Referrer-Policy` sends to this origin and to others.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sent {
    same: Part,
    cross: Part,
}

impl Default for Sent {
    /// `strict-origin-when-cross-origin`.
    fn default() -> Self {
        Sent { same: Part::Address, cross: Part::Origin }
    }
}

impl Sent {
    fn of(referrer: Referrer) -> Self {
        match referrer {
            Referrer::StrictOrigin => Sent { same: Part::Origin, cross: Part::Origin },
            Referrer::SameOrigin => Sent { same: Part::Address, cross: Part::Nothing },
            Referrer::NoReferrer => Sent { same: Part::Nothing, cross: Part::Nothing },
        }
    }

    /// The least of each, as the policy that sends it: two that send the same compare equal.
    fn and(self, other: Sent) -> Sent {
        match (self.same.min(other.same), self.cross.min(other.cross)) {
            (Part::Address, Part::Origin | Part::Address) => Sent::default(),
            (Part::Origin, Part::Origin | Part::Address) => Sent::of(Referrer::StrictOrigin),
            (Part::Address, Part::Nothing) => Sent::of(Referrer::SameOrigin),
            // Less than `strict-origin` to this site and nothing to others has no name of its own:
            // nothing, to anyone.
            _ => Sent::of(Referrer::NoReferrer),
        }
    }

    /// What one policy token sends over HTTPS, the only scheme a page with these headers is
    /// served on in production; `None` for a token the browser does not know either.
    fn token(token: &str) -> Option<Sent> {
        let (same, cross) = match token.trim().to_ascii_lowercase().as_str() {
            "no-referrer" => (Part::Nothing, Part::Nothing),
            "same-origin" => (Part::Address, Part::Nothing),
            "origin" | "strict-origin" => (Part::Origin, Part::Origin),
            "origin-when-cross-origin" | "strict-origin-when-cross-origin" => (Part::Address, Part::Origin),
            "unsafe-url" | "no-referrer-when-downgrade" => (Part::Address, Part::Address),
            _ => return None,
        };
        Some(Sent { same, cross })
    }

    /// The policy of an answer's `Referrer-Policy` lines: the browser reads them as one list and
    /// uses the last token it knows.
    fn parse<'a>(values: impl DoubleEndedIterator<Item = &'a HeaderValue>) -> Option<Sent> {
        values.rev().find_map(|value| value.to_str().ok()?.rsplit(',').find_map(Sent::token))
    }

    /// Built per answer from constants, which costs less than cloning a stored value. `and`
    /// gives only these four.
    fn header(self) -> HeaderValue {
        const DEFAULT: HeaderValue = HeaderValue::from_static("strict-origin-when-cross-origin");
        const STRICT_ORIGIN: HeaderValue = HeaderValue::from_static("strict-origin");
        const SAME_ORIGIN: HeaderValue = HeaderValue::from_static("same-origin");
        const NO_REFERRER: HeaderValue = HeaderValue::from_static("no-referrer");
        match (self.same, self.cross) {
            (Part::Address, Part::Origin) => DEFAULT,
            (Part::Origin, Part::Origin) => STRICT_ORIGIN,
            (Part::Address, Part::Nothing) => SAME_ORIGIN,
            // Less than `strict-origin` to this site and nothing to others has no name of its own:
            // nothing, to anyone.
            _ => NO_REFERRER,
        }
    }
}

/// `Cross-Origin-Opener-Policy`, from the most isolated: an area only moves it down the list.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
enum Opener {
    #[default]
    SameOrigin,
    AllowPopups,
    Unsafe,
}

impl Opener {
    fn header(self) -> HeaderValue {
        HeaderValue::from_static(match self {
            Opener::SameOrigin => "same-origin",
            Opener::AllowPopups => "same-origin-allow-popups",
            Opener::Unsafe => "unsafe-none",
        })
    }
}

// Declares `Feature`, its list and its names from one table, so no feature can be left out of
// what the header denies.
macro_rules! features {
    ($(#[doc = $enum_doc:literal])* ; $($(#[doc = $doc:literal])* $feature:ident = $name:literal,)*) => {
        $(#[doc = $enum_doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[non_exhaustive]
        pub enum Feature {
            $($(#[doc = $doc])* $feature,)*
        }

        impl Feature {
            /// Every feature, in the order the header names them, each its own bit of a `u32`.
            const ALL: &[Feature] = &[$(Feature::$feature,)*];

            /// The name `Permissions-Policy` gives it.
            const fn name(self) -> &'static str {
                match self {
                    $(Feature::$feature => $name,)*
                }
            }
        }
    };
}

features! {
    /// A powerful feature a page is denied unless the app allows it: every page is sent
    /// `Permissions-Policy: camera=(), geolocation=(), ...`, so a script the policy allows (an analytics
    /// tag, a payment SDK) cannot ask the user for a camera or a location under the app's name, or read
    /// the motion sensors, which ask no one, and no frame in the page can be given the feature
    /// either. [`Policy::allow_feature`] allows one on every page, [`Sources::allow_feature`] on an
    /// area's; a page that is allowed one is back to the browser's default for it (this origin, and a
    /// frame the app's markup gives it with `allow`). Only Chromium-based browsers read the header
    /// today; in Firefox and WebKit these features are the browser's to grant, as before. A feature is named by this type, so a
    /// misspelled one does not build where a string would be ignored by the browser:
    ///
    /// ```compile_fail,E0308
    /// use corten::security::Policy;
    /// let _ = Policy::new().allow_feature("geolocaton");
    /// ```
    ;
    /// `accelerometer`: the device's motion, which the browser shows no prompt for.
    Accelerometer = "accelerometer",
    /// `bluetooth`: Web Bluetooth devices.
    Bluetooth = "bluetooth",
    /// `camera`: `getUserMedia` video.
    Camera = "camera",
    /// `display-capture`: `getDisplayMedia`, a recording of the screen.
    DisplayCapture = "display-capture",
    /// `geolocation`: the user's location.
    Geolocation = "geolocation",
    /// `gyroscope`: the device's rotation, which the browser shows no prompt for.
    Gyroscope = "gyroscope",
    /// `hid`: WebHID devices.
    Hid = "hid",
    /// `idle-detection`: whether the user is at the device.
    IdleDetection = "idle-detection",
    /// `local-fonts`: the fonts installed on the device.
    LocalFonts = "local-fonts",
    /// `magnetometer`: the device's heading, which the browser shows no prompt for.
    Magnetometer = "magnetometer",
    /// `microphone`: `getUserMedia` audio.
    Microphone = "microphone",
    /// `midi`: Web MIDI devices.
    Midi = "midi",
    /// `payment`: the Payment Request API, which a provider's payment button in a frame uses.
    Payment = "payment",
    /// `serial`: Web Serial ports.
    Serial = "serial",
    /// `usb`: WebUSB devices.
    Usb = "usb",
    /// `window-management`: the user's screens and placing windows on them.
    WindowManagement = "window-management",
}

// Each feature is a bit of `Sources::features`.
const _: () = assert!(Feature::ALL.len() <= u32::BITS as usize);

impl Feature {
    const fn bit(self) -> u32 {
        1 << self as u32
    }

    /// The `Permissions-Policy` that denies every feature not in `allowed`, built once per
    /// policy at startup; none when every one is allowed.
    fn denied(allowed: u32) -> Option<HeaderValue> {
        let names: Vec<String> = Feature::ALL
            .iter()
            .filter(|feature| allowed & feature.bit() == 0)
            .map(|feature| format!("{}=()", feature.name()))
            .collect();
        (!names.is_empty()).then(|| HeaderValue::try_from(names.join(", ")).expect("feature names are header text"))
    }
}

impl Sources {
    /// Another origin scripts may load from ([`Policy::script_src`]).
    pub fn script_src(mut self, source: &str) -> Self {
        self.script.push(checked(source));
        self
    }

    /// Another origin stylesheets may load from ([`Policy::style_src`]).
    pub fn style_src(mut self, source: &str) -> Self {
        self.style.push(checked(source));
        self
    }

    /// Another origin images may load from ([`Policy::img_src`]).
    pub fn img_src(mut self, source: &str) -> Self {
        self.img.push(checked(source));
        self
    }

    /// Another origin `fetch` and `EventSource` may reach ([`Policy::connect_src`]).
    pub fn connect_src(mut self, source: &str) -> Self {
        self.connect.push(checked(source));
        self
    }

    /// An origin the page may embed in an `<iframe>` ([`Policy::frame_src`]).
    pub fn frame_src(mut self, source: &str) -> Self {
        self.frame.push(checked(source));
        self
    }

    /// Another origin fonts may load from ([`Policy::font_src`]).
    pub fn font_src(mut self, source: &str) -> Self {
        self.font.push(checked(source));
        self
    }

    /// Another origin a form may send the user to ([`Policy::form_action`]).
    pub fn form_action(mut self, source: &str) -> Self {
        self.form_action.push(checked(source));
        self
    }

    /// An origin that may show these pages in an `<iframe>` ([`Policy::frame_ancestors`]): a
    /// host or a scheme, or `'self'`. No other keyword means anything there, and `'none'` is
    /// what these pages have without one.
    pub fn frame_ancestors(mut self, source: &str) -> Self {
        let source = checked(source);
        assert!(
            !source.starts_with('\'') || source == "'self'",
            "a frame-ancestors source is a host, a scheme or 'self': {source:?}"
        );
        self.ancestors.push(source);
        self
    }

    /// A Trusted Types policy a script may create ([`Policy::trusted_types_policy`]).
    pub fn trusted_types_policy(mut self, name: &str) -> Self {
        assert!(
            !name.is_empty() && name != "corten" && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-#=_/@.%".contains(&b)),
            "a Trusted Types policy name is letters, digits and -#=_/@.%, and not corten: {name:?}"
        );
        if !self.trusted_types.iter().any(|n| n == name) {
            self.trusted_types.push(name.to_string());
        }
        self
    }

    /// A powerful feature these pages may use ([`Policy::allow_feature`]).
    pub fn allow_feature(mut self, feature: Feature) -> Self {
        self.features |= feature.bit();
        self
    }

    /// Allows `style="..."` attributes in markup ([`Policy::allow_style_attributes`]).
    pub fn allow_style_attributes(mut self) -> Self {
        self.style_attributes = true;
        self
    }

    /// Lets popups these pages open keep `window.opener` ([`Policy::allow_popups`]).
    pub fn allow_popups(mut self) -> Self {
        self.opener = self.opener.max(Opener::AllowPopups);
        self
    }

    /// `Cross-Origin-Opener-Policy: unsafe-none` on these pages, for an embed whose sign-in
    /// popup talks back to them ([`Policy::allow_cross_origin_opener`]).
    pub fn allow_cross_origin_opener(mut self) -> Self {
        self.opener = Opener::Unsafe;
        self
    }

    /// A stricter `Referrer-Policy` for these pages and every answer under them, so an address
    /// that carries a secret (`/consent?token=..`) is not sent with the requests the page makes,
    /// its own stylesheet's included. Given twice, or by an area inside another, each sends the
    /// least either allows. A navigation into or out of these pages loads the whole document,
    /// since a document keeps the policy it loaded with.
    pub fn referrer(mut self, referrer: Referrer) -> Self {
        self.referrer = self.referrer.and(Sent::of(referrer));
        self
    }

    pub(crate) fn is_empty(&self) -> bool {
        let Sources {
            script,
            style,
            img,
            connect,
            frame,
            font,
            form_action,
            ancestors,
            trusted_types,
            features,
            style_attributes,
            opener,
            referrer,
        } = self;
        [script, style, img, connect, frame, font, form_action, ancestors, trusted_types].iter().all(|list| list.is_empty())
            && *features == 0
            && !style_attributes
            && *opener == Opener::SameOrigin
            && *referrer == Sent::default()
    }

    /// Whether scripts may load from another host (a `script_src` that names one: not a keyword,
    /// a nonce, a hash or a scheme alone such as `data:` or `https:`), and the app does not make
    /// the `default` policy itself: then the pages allow `default`, and [`SCRIPT_LOADS`] makes it.
    /// Not under `'strict-dynamic'` (in any case, as the browser reads keywords), where the browser
    /// ignores the hosts listed, so the policy would pass a script from any origin.
    pub(crate) fn script_loads(&self) -> bool {
        self.script.iter().any(|source| !source.starts_with('\'') && !source.ends_with(':'))
            && !self.script.iter().any(|source| source.eq_ignore_ascii_case("'strict-dynamic'"))
            && !self.trusted_types.iter().any(|n| n == "default")
    }

    /// Adds `more`'s sources, each once.
    fn add(&mut self, more: &Sources) {
        let pairs = [
            (&mut self.script, &more.script),
            (&mut self.style, &more.style),
            (&mut self.img, &more.img),
            (&mut self.connect, &more.connect),
            (&mut self.frame, &more.frame),
            (&mut self.font, &more.font),
            (&mut self.form_action, &more.form_action),
            (&mut self.ancestors, &more.ancestors),
            (&mut self.trusted_types, &more.trusted_types),
        ];
        for (list, more) in pairs {
            for source in more {
                if !list.contains(source) {
                    list.push(source.clone());
                }
            }
        }
        self.features |= more.features;
        self.style_attributes |= more.style_attributes;
        self.opener = self.opener.max(more.opener);
        self.referrer = self.referrer.and(more.referrer);
    }
}

/// The CSP source of a page's style block (its custom properties, `style={..}` in markup), set
/// on the response by [`crate::Req::page`]: [`Applied::headers`] adds it to the page's
/// `style-src`, so the block applies and nothing else inline does.
#[derive(Clone, Debug)]
pub(crate) struct StyleBlock(pub String);

/// Where a page's style block's hash goes in a CSP: after `style-src 'self'`, which every policy
/// writes (`csp_with`).
const STYLE_AT: &str = "style-src 'self'";

/// `'sha256-...'`, the CSP source that allows the inline element whose text is `text`.
pub(crate) fn hash_source(text: &str) -> String {
    format!("'sha256-{}'", base64(&sha256(text.as_bytes())))
}

/// The script a page whose `script_src` names another host runs at `<Corten />`, allowed by its
/// hash: the `default` Trusted Types policy, which the browser asks about a string a script sets
/// as a script's URL with no policy of its own (an SDK's loader, and the SDK loading its parts).
/// It passes an http or https URL on another origin, which `script-src` then holds to the hosts
/// listed, and nothing else: no URL on this origin, no markup, no script text. A classic inline
/// script, so it runs where it stands, before every script after it; the runtime is a module and
/// runs only once the page is parsed. If a script before it made `default` already, it says so
/// in the console, since that one then decides what passes.
pub(crate) const SCRIPT_LOADS: &str = r#"self.trustedTypes&&(trustedTypes.defaultPolicy?console.error("corten: a script before <Corten /> made the default Trusted Types policy, so it, not Corten's, decides what passes"):trustedTypes.createPolicy("default",{createScriptURL(u){try{const a=new URL(u,location.href);return/^https?:$/.test(a.protocol)&&a.origin!==location.origin?u:null}catch{return null}}}))"#;

/// SHA-256 (FIPS 180-4), for the CSP hashes of Corten's inline tags: computed once at startup,
/// except a page's style block, once per page that has one, so a small plain implementation
/// serves instead of a dependency.
fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
        0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
        0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let (blocks, rest) = data.as_chunks::<64>();
    for block in blocks {
        compress(&mut h, block, &K);
    }
    // The last bytes, the 1 bit, zeros and the length in bits: one block, or two when the length
    // does not fit after the last bytes.
    let mut tail = [0u8; 128];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] = 0x80;
    let len = if rest.len() < 56 { 64 } else { 128 };
    tail[len - 8..len].copy_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in tail[..len].as_chunks::<64>().0 {
        compress(&mut h, block, &K);
    }
    let mut out = [0u8; 32];
    for (bytes, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(h) {
        *bytes = word.to_be_bytes();
    }
    out
}

/// One block of SHA-256 into the state `h`.
fn compress(h: &mut [u32; 8], block: &[u8; 64], k: &[u32; 64]) {
    let mut w = [0u32; 64];
    for (word, bytes) in w.iter_mut().zip(block.as_chunks::<4>().0) {
        *word = u32::from_be_bytes(*bytes);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
    // Eight rounds at a time, each naming the words where the last left them, so no round moves
    // the state along.
    for (k, w) in k.as_chunks::<8>().0.iter().zip(w.as_chunks::<8>().0) {
        let kw = |j: usize| k[j].wrapping_add(w[j]);
        round([a, b, c], &mut d, [e, f, g], &mut hh, kw(0));
        round([hh, a, b], &mut c, [d, e, f], &mut g, kw(1));
        round([g, hh, a], &mut b, [c, d, e], &mut f, kw(2));
        round([f, g, hh], &mut a, [b, c, d], &mut e, kw(3));
        round([e, f, g], &mut hh, [a, b, c], &mut d, kw(4));
        round([d, e, f], &mut g, [hh, a, b], &mut c, kw(5));
        round([c, d, e], &mut f, [g, hh, a], &mut b, kw(6));
        round([b, c, d], &mut e, [f, g, hh], &mut a, kw(7));
    }
    for (state, add) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
        *state = state.wrapping_add(add);
    }
}

/// One round of SHA-256 on the words `a b c` `d` `e f g` `h`, with its constant and message word
/// added (`kw`): `d` takes the new `e` and `h` the new `a`.
#[inline(always)]
fn round([a, b, c]: [u32; 3], d: &mut u32, [e, f, g]: [u32; 3], h: &mut u32, kw: u32) {
    let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
    let choice = g ^ (e & (f ^ g));
    let t1 = h.wrapping_add(s1).wrapping_add(choice).wrapping_add(kw);
    let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
    let majority = (a & b) | (c & (a | b));
    *d = d.wrapping_add(t1);
    *h = t1.wrapping_add(s0.wrapping_add(majority));
}

/// Standard base64 with padding.
pub(crate) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = (byte(0) << 16) | (byte(1) << 8) | byte(2);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A policy in use: its CSP split around the nonce, and the headers that do not change.
pub(crate) struct Applied {
    policy: Policy,
    /// The app's pages' CSP.
    pub csp: Arc<Csp>,
    /// The CSP and opener policy of the pages of each area whose policy adds something the app's
    /// lacks, innermost prefix first, with what it adds to a page's shell key: a client navigation
    /// between pages with different policies loads the document in full, since a document keeps
    /// the policies it loaded with.
    areas: Vec<(&'static str, Arc<Csp>, u64)>,
    api_csp: HeaderValue,
    /// The `form-action` of each policy, for a debug build's check of a write's redirect.
    #[cfg(debug_assertions)]
    forms: Arc<FormPolicy>,
}

/// One CSP for pages, split around the nonce once, at startup, and the opener and referrer
/// policies sent with it.
pub(crate) struct Csp {
    parts: Vec<String>,
    without_nonce: HeaderValue,
    /// Where a style block's hash is written: the end of `style-src 'self'` in `without_nonce`,
    /// and the part of `parts` that holds it with the offset of its end there.
    style_at: (usize, usize, usize),
    opener: HeaderValue,
    referrer: Sent,
    /// `X-Frame-Options` for browsers that do not read `frame-ancestors`: `DENY` when no one may
    /// frame its pages, `SAMEORIGIN` when only the app may, none when another origin may (the
    /// header cannot name one).
    frame_options: Option<HeaderValue>,
    /// Its `frame-ancestors` alone, as an enforced policy of its own: sent beside a relayed page's
    /// own CSP, which may not widen who frames the app's pages, and under report-only on a page
    /// another origin may frame, which has no `X-Frame-Options` to enforce it.
    ancestors: HeaderValue,
    /// The `Permissions-Policy` of its full documents ([`Feature`]); none when every feature is
    /// allowed.
    permissions: Option<HeaderValue>,
    /// Whether scripts may load from another host, so `<Corten />` makes the `default` policy
    /// that lets a script set such a URL ([`Sources::script_loads`]). Its CSP allows that script by
    /// hash, so it differs from one whose app makes `default`, and so does its shell key.
    pub(crate) script_loads: bool,
    /// Its `form-action` sources besides `'self'`, which a debug build checks a write's redirect
    /// against ([`FormTargets`]).
    #[cfg(debug_assertions)]
    form_action: Vec<String>,
}

impl Csp {
    fn new(policy: &Policy, import_map: &str) -> Self {
        let parts: Vec<String> = policy.csp_with(Some("\0"), import_map).split('\0').map(str::to_string).collect();
        let text = policy.csp_with(None, import_map);
        let at = text.find(STYLE_AT).expect("every policy writes style-src 'self'") + STYLE_AT.len();
        let (part, offset) = parts
            .iter()
            .enumerate()
            .find_map(|(i, part)| part.find(STYLE_AT).map(|at| (i, at + STYLE_AT.len())))
            .expect("every policy writes style-src 'self'");
        let without_nonce = HeaderValue::try_from(text).expect("CSP sources are checked tokens");
        Csp {
            parts,
            without_nonce,
            style_at: (at, part, offset),
            opener: policy.sources.opener.header(),
            referrer: policy.sources.referrer,
            frame_options: match policy.sources.ancestors.as_slice() {
                [] => Some(HeaderValue::from_static("DENY")),
                selfs if selfs.iter().all(|s| s == "'self'") => Some(HeaderValue::from_static("SAMEORIGIN")),
                _ => None,
            },
            ancestors: match policy.sources.ancestors.as_slice() {
                [] => HeaderValue::from_static("frame-ancestors 'none'"),
                sources => HeaderValue::try_from(format!("frame-ancestors {}", sources.join(" ")))
                    .expect("CSP sources are checked tokens"),
            },
            permissions: Feature::denied(policy.sources.features),
            script_loads: policy.sources.script_loads(),
            #[cfg(debug_assertions)]
            form_action: policy.sources.form_action.clone(),
        }
    }

    /// The header with `nonce` (when there is one) and `hash`, a page's style block's, among its
    /// `style-src` sources.
    fn with_style(&self, nonce: Option<&str>, hash: &str) -> Option<HeaderValue> {
        let mut text = String::with_capacity(self.without_nonce.len() + hash.len() + nonce.map_or(0, |n| 2 * (n.len() + 10)));
        match nonce {
            None => {
                let csp = std::str::from_utf8(self.without_nonce.as_bytes()).ok()?;
                text.push_str(&csp[..self.style_at.0]);
                text.push(' ');
                text.push_str(hash);
                text.push_str(&csp[self.style_at.0..]);
            }
            Some(nonce) => {
                for (i, part) in self.parts.iter().enumerate() {
                    if i > 0 {
                        text.push_str(nonce);
                    }
                    if i == self.style_at.1 {
                        text.push_str(&part[..self.style_at.2]);
                        text.push(' ');
                        text.push_str(hash);
                        text.push_str(&part[self.style_at.2..]);
                    } else {
                        text.push_str(part);
                    }
                }
            }
        }
        HeaderValue::try_from(text).ok()
    }
}

impl std::ops::Deref for Applied {
    type Target = Policy;
    fn deref(&self) -> &Policy {
        &self.policy
    }
}

const PERMISSIONS_POLICY: HeaderName = HeaderName::from_static("permissions-policy");
const REPORTING_ENDPOINTS: HeaderName = HeaderName::from_static("reporting-endpoints");

/// Adds `csp`'s endpoint ([`Policy::report_to`]) to an answer's `Reporting-Endpoints`, beside
/// any the app's middleware or handler set for other reports (the lines are one dictionary to
/// the browser). A relayed page keeps its own, as it keeps its CSP, and a line that already names
/// `csp` is the answer's own choice.
pub(crate) fn endpoints(res: &mut Response, csp: &HeaderValue) {
    if res.extensions().get::<crate::answer::Relayed>().is_some() {
        return;
    }
    // One lookup of the name: an answer seldom has a line of its own.
    match res.headers_mut().entry(REPORTING_ENDPOINTS) {
        http::header::Entry::Vacant(entry) => {
            entry.insert(csp.clone());
        }
        http::header::Entry::Occupied(mut entry) => {
            if !entry.iter().any(|line| names(line.as_bytes(), b"csp")) {
                entry.append(csp.clone());
            }
        }
    }
}

/// Whether a structured-field dictionary (`Reporting-Endpoints`) has a member `key`: a comma
/// inside a quoted URL does not start one.
fn names(line: &[u8], key: &[u8]) -> bool {
    let (mut quoted, mut escaped, mut start) = (false, false, 0);
    for (i, &b) in line.iter().enumerate().chain(std::iter::once((line.len(), &b','))) {
        if quoted {
            match (escaped, b) {
                (false, b'\\') => escaped = true,
                (false, b'"') => quoted = false,
                _ => escaped = false,
            }
        } else if b == b'"' {
            quoted = true;
        } else if b == b',' {
            let member = line[start..i].trim_ascii();
            if member.split(|&b| b == b'=').next() == Some(key) {
                return true;
            }
            start = i + 1;
        }
    }
    false
}

/// Whether a `Content-Type` is a document a browser may run scripts in: HTML, or any XML (XHTML,
/// SVG, `text/xml`, a `+xml` type), which runs an XHTML `<script>` in it; the media type is
/// compared without case (RFC 9110 8.3.1).
#[inline]
fn html(kind: &[u8]) -> bool {
    // What Corten's own pages send, compared first.
    if kind == b"text/html; charset=utf-8" {
        return true;
    }
    let essence = kind.split(|&b| b == b';').next().unwrap_or(b"").trim_ascii();
    let ends =
        |suffix: &[u8]| essence.len() >= suffix.len() && essence[essence.len() - suffix.len()..].eq_ignore_ascii_case(suffix);
    [&b"text/html"[..], b"text/xml", b"application/xml"].iter().any(|t| essence.eq_ignore_ascii_case(t)) || ends(b"+xml")
}

/// Corten's `Permissions-Policy` line before the ones an answer set (a middleware that denies
/// more), so a feature the answer names is the answer's; a relayed page keeps the one its upstream
/// sent alone (a line the app's middleware adds to a relayed page that brought none still follows
/// Corten's).
#[cold]
#[inline(never)]
fn ours_first(res: &mut Response, ours: &HeaderValue) {
    if res.extensions().get::<crate::answer::Relayed>().is_some_and(|relayed| relayed.features) {
        return;
    }
    let headers = res.headers_mut();
    let theirs: Vec<HeaderValue> = headers.get_all(PERMISSIONS_POLICY).iter().cloned().collect();
    headers.insert(PERMISSIONS_POLICY, ours.clone());
    for line in theirs {
        headers.append(PERMISSIONS_POLICY, line);
    }
}

/// The CSP of JSON-only routes ([`crate::App::api`]): nothing loads, nothing frames them.
const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'";

impl Applied {
    /// `import_map` is the text of the app's import map, allowed by its hash. `areas` are the
    /// prefixes of the areas that add to the policy, with what each adds: a page in one gets the
    /// app's sources, then those of each such area it is under, outermost first.
    pub fn new(policy: Policy, import_map: &str, areas: &[(&'static str, &Sources)]) -> Self {
        let csp = Csp::new(&policy, import_map);
        let mut placed: Vec<(&'static str, Arc<Csp>, u64)> = areas
            .iter()
            .filter_map(|&(prefix, _)| {
                let mut outer: Vec<_> = areas.iter().filter(|(other, _)| crate::api::under(other, prefix)).collect();
                outer.sort_by_key(|(other, _)| other.len());
                let mut merged = policy.clone();
                for (_, sources) in outer {
                    merged.sources.add(sources);
                }
                let area = Csp::new(&merged, import_map);
                // An area that adds nothing the app lacks keeps the app's policy and shell key.
                if area.without_nonce == csp.without_nonce
                    && area.opener == csp.opener
                    && area.referrer == csp.referrer
                    && area.permissions == csp.permissions
                {
                    return None;
                }
                let mut hasher = std::hash::DefaultHasher::new();
                std::hash::Hash::hash(area.without_nonce.as_bytes(), &mut hasher);
                std::hash::Hash::hash(area.opener.as_bytes(), &mut hasher);
                std::hash::Hash::hash(area.referrer.header().as_bytes(), &mut hasher);
                std::hash::Hash::hash(&area.permissions.as_ref().map(HeaderValue::as_bytes), &mut hasher);
                Some((prefix, Arc::new(area), std::hash::Hasher::finish(&hasher) | 1))
            })
            .collect();
        placed.sort_by_key(|(prefix, ..)| std::cmp::Reverse(prefix.len()));
        #[cfg(debug_assertions)]
        let forms = Arc::new(FormPolicy {
            names: policy.hosts.clone().unwrap_or_default(),
            app: csp.form_action.clone(),
            areas: placed.iter().map(|(prefix, csp, _)| (*prefix, csp.form_action.clone())).collect(),
        });
        Applied {
            policy,
            csp: Arc::new(csp),
            areas: placed,
            api_csp: HeaderValue::from_static(API_CSP),
            #[cfg(debug_assertions)]
            forms,
        }
    }

    /// The CSP of the pages at `path` and what it adds to their shell key: its innermost area's
    /// that adds to the policy, else the app's (and 0). Read once for each area and API when the
    /// router is built, into its scope ([`crate::app::Scope`]).
    pub fn csp_for(&self, path: &str) -> (Arc<Csp>, u64) {
        let area = self.areas.iter().find(|(prefix, ..)| crate::api::under(prefix, path));
        area.map_or((self.csp.clone(), 0), |(_, csp, key)| (csp.clone(), *key))
    }

    /// What a debug build needs to hold a redirect answering this request to the `form-action`
    /// of the form's page ([`FormCheck`]), when it is a submission: a `GET` form cannot be told
    /// from a link, and a script's own `fetch` is held to `connect-src`. Only the request's
    /// headers are kept; the page and its policy are worked out for a redirect to another address.
    #[cfg(debug_assertions)]
    pub(crate) fn form_check(&self, req: &Request, origin: &mut Origin<'_>, action: bool) -> Option<FormCheck> {
        // A report-only policy stops nothing: the browser reports the redirect and follows it. A
        // form sends only GET and POST, and a GET form cannot be told from a link.
        if self.report_only || *req.method() != Method::POST {
            return None;
        }
        let headers = req.headers();
        // A body a form cannot send (JSON from a webhook or a native client) is not a form's.
        let form_type = |kind: &[u8]| {
            let kind = kind.split(|&b| b == b';').next().unwrap_or(b"").trim_ascii();
            [&b"application/x-www-form-urlencoded"[..], b"multipart/form-data", b"text/plain"]
                .iter()
                .any(|t| kind.eq_ignore_ascii_case(t))
        };
        if headers.get(header::CONTENT_TYPE).is_some_and(|kind| !form_type(kind.as_bytes())) {
            return None;
        }
        // The runtime's `data-patch` submission is a `fetch` too, and is checked: the same form
        // without JavaScript is a submission the browser holds to `form-action`.
        let scripted = headers.get("sec-fetch-mode").is_some_and(|mode| mode.as_bytes() != b"navigate");
        if scripted && !action {
            return None;
        }
        Some(FormCheck {
            forms: self.forms.clone(),
            uri: req.uri().clone(),
            host: origin.host().cloned(),
            origin: origin.value().cloned(),
            referer: headers.get(header::REFERER).cloned(),
            site: origin.site().cloned(),
            action,
        })
    }

    /// The 403 for a write another site sent. A mount's extra origins can send token-based writes,
    /// never a write using ambient cookies.
    pub fn refuse(&self, req: &Request, origin: &mut Origin<'_>, from_mount: bool) -> Option<Response> {
        if !Origin::checks(req.method()) || from_mount || origin.permits(&self.allowed_origins, self.hsts, req.uri()) {
            return None;
        }
        Some(crate::cache::unshared((StatusCode::FORBIDDEN, "Cross-site request refused.").into_response()))
    }

    /// The security headers. `csp` is the policy of the area at the request's path (the app's
    /// when it is in none), and `nonce` the request's nonce slot, or `None` for a response that is
    /// never a page (an API route, a misdirected request), which gets a CSP that allows nothing and
    /// the app's opener policy, and still the area's referrer policy. `vary` says whether the
    /// answer has a `Vary` already, as the app's last stage found when it settled the language
    /// (`crate::page::vary_on_language`).
    pub fn headers(&self, res: &mut Response, nonce: Option<&NonceSlot>, csp: &Csp, vary: bool) {
        let page = nonce.map(|nonce| (nonce, csp));
        let block = if page.is_some() { res.extensions_mut().remove::<StyleBlock>() } else { None };
        let headers = res.headers_mut();
        // Room for the headers below and `Cache-Control` (`Vary` from compression is appended to an
        // existing one, or added): the map grows at most once, and not at all when a page reserved
        // enough. Asking for more than this reallocates an error page's map for nothing. A
        // document's `Permissions-Policy` fits in what a page reserves (13), with room left.
        headers.reserve(6 + usize::from(self.hsts) + usize::from(!vary));
        let csp_header =
            if self.report_only { header::CONTENT_SECURITY_POLICY_REPORT_ONLY } else { header::CONTENT_SECURITY_POLICY };
        let ours = csp.referrer;
        let opener = if page.is_some() { csp.opener.clone() } else { self.csp.opener.clone() };
        // A response that is never a page is framed by no one, as its CSP says.
        const NO_FRAMES: HeaderValue = HeaderValue::from_static("frame-ancestors 'none'");
        let no_frames;
        let (frame_options, ancestors) = match page {
            Some(_) => (csp.frame_options.clone(), &csp.ancestors),
            None => {
                no_frames = NO_FRAMES;
                (Some(HeaderValue::from_static("DENY")), &no_frames)
            }
        };
        let csp = match (page.map(|(slot, csp)| (slot.taken(), csp)), block) {
            (None, _) => Some(self.api_csp.clone()),
            (Some((None, csp)), None) => Some(csp.without_nonce.clone()),
            // A hash that made no header value (it cannot: base64 is header text) leaves the block
            // blocked, never the page without a policy.
            (Some((None, csp)), Some(StyleBlock(hash))) => {
                csp.with_style(None, &hash).or_else(|| Some(csp.without_nonce.clone()))
            }
            (Some((Some(nonce), csp)), None) => HeaderValue::try_from(csp.parts.join(&*nonce.0)).ok(),
            (Some((Some(nonce), csp)), Some(StyleBlock(hash))) => {
                csp.with_style(Some(&nonce.0), &hash).or_else(|| HeaderValue::try_from(csp.parts.join(&*nonce.0)).ok())
            }
        };
        // A response that brings a policy of its own is a relayed page (or a bug): it keeps it.
        let kept = csp.and_then(|csp| headers.insert(csp_header, csp)).is_some_and(|brought| self.keep_relayed(res, brought));
        let headers = res.headers_mut();
        // Who may frame a page is enforced even where the app's CSP is not: beside a relayed page's
        // own, and under report-only on a page with no `X-Frame-Options` to fall back on or with an
        // enforced policy an upstream brought, which could widen it.
        let enforce = |headers: &HeaderMap| {
            kept || (self.report_only && (frame_options.is_none() || headers.contains_key(header::CONTENT_SECURITY_POLICY)))
        };
        if enforce(headers) {
            headers.append(header::CONTENT_SECURITY_POLICY, ancestors.clone());
        }
        headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        // An answer that brings a stricter policy (a relayed one, a handler's own) keeps it.
        match headers.entry(header::REFERRER_POLICY) {
            http::header::Entry::Vacant(entry) => {
                entry.insert(ours.header());
            }
            http::header::Entry::Occupied(entry) => stricter_referrer(entry, ours),
        }
        // Who may frame a page is its policy's, whatever its handler, middleware or upstream set: one
        // another origin may frame has none (the header cannot name one).
        match frame_options {
            Some(value) => headers.insert(header::X_FRAME_OPTIONS, value),
            None => headers.remove(header::X_FRAME_OPTIONS),
        };
        headers.insert(HeaderName::from_static("cross-origin-opener-policy"), opener);
        if self.hsts {
            headers.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static("max-age=31536000; includeSubDomains"));
        }
    }

    /// The lines [`Applied::headers`] and [`crate::cache::settle`] give an answer that brings none
    /// of them and asks for nothing of its own (no nonce, no style block), made once for a scope:
    /// `csp` is the scope's and `page` whether its answers can be pages (not an API's). Those two
    /// write it, so it holds what they would insert, whatever the policy.
    pub(crate) fn lines(&self, csp: &Csp, page: bool) -> HeaderMap {
        let mut res = Response::new(crate::body::Body::empty());
        let slot = page.then(NonceSlot::default);
        self.headers(&mut res, slot.as_ref(), csp, false);
        let seen = crate::cache::Seen { credentials: false, caller: false, partial: false, nonce: false, dev: false };
        crate::cache::settle(&mut res, seen, "");
        res.into_parts().0.headers
    }

    /// Adds each of its scope's `lines` ([`Applied::lines`]) to `res`, in one pass, in place of
    /// [`Applied::headers`], [`Applied::document`] and [`crate::cache::settle`], when those would
    /// leave the same lines in the same order: an answer with no header, or its `Content-Type`
    /// alone, that is not a document or a worker's script those give lines of its own, on a
    /// request that took no nonce and drew no style block, and without a [`crate::cache::Cache`]
    /// mark (one whose header a middleware took out is settled by its mark). `nonce` and `csp`
    /// are what [`Applied::headers`] is given, and `caller` whether something read a [`crate::Caller`]: such
    /// an answer is marked [`crate::cache::Personal`], as `settle` marks it, the one thing `settle`
    /// does differently for who asked to an answer this takes. Returns whether it did; `res` is
    /// untouched when not.
    #[inline]
    pub(crate) fn ready(
        &self,
        res: &mut Response,
        lines: &HeaderMap,
        nonce: Option<&NonceSlot>,
        csp: &Csp,
        caller: bool,
    ) -> bool {
        // A page brings more than its type: it is told apart here, without a call.
        res.headers().len() <= 1 && self.give(res, lines, nonce, csp, caller)
    }

    /// [`Applied::ready`], for an answer with one header at most.
    #[inline(never)]
    fn give(&self, res: &mut Response, lines: &HeaderMap, nonce: Option<&NonceSlot>, csp: &Csp, caller: bool) -> bool {
        let kind = match res.headers().iter().next() {
            None => None,
            Some((name, kind)) if name == header::CONTENT_TYPE => Some(kind),
            Some(_) => return false,
        };
        // A `Cache` answer whose header a middleware took out is settled by its mark.
        if crate::cache::Typed::marked(res) {
            return false;
        }
        if let Some(slot) = nonce {
            if slot.taken().is_some() || res.extensions().get::<StyleBlock>().is_some() {
                return false;
            }
            // What `document` adds to: a document, and a worker's script.
            if self.adds_to_documents(csp)
                && (kind.is_some_and(|kind| html(kind.as_bytes()))
                    || res.extensions().get::<crate::pwa::WorkerScript>().is_some())
            {
                return false;
            }
        }
        let headers = res.headers_mut();
        // Room for them and one more (`Vary`), as `headers` reserves: the map grows at most once.
        headers.reserve(lines.len() + 1);
        for (name, value) in lines {
            headers.append(name, value.clone());
        }
        // One visitor's, for an app that relays it inline ([`crate::cache::Personal`]).
        if caller {
            res.extensions_mut().insert(crate::cache::Personal);
        }
        true
    }

    /// Whether [`Applied::document`] has a line to add under `csp`: a feature to deny, or where
    /// reports go. Read by it and by [`Applied::ready`], which leaves it the answers it adds to.
    #[inline]
    fn adds_to_documents(&self, csp: &Csp) -> bool {
        csp.permissions.is_some() || self.reporting.is_some()
    }

    /// `Permissions-Policy` ([`Feature`]) on a document, an HTML or XML answer that is not one the
    /// runtime swaps in (`corten-page`, `corten-patch`, to its own request): those are drawn into a
    /// page that keeps the policy it loaded with, and a stylesheet, a script or JSON has no features
    /// to deny. It is decided by the answer, not the request alone, so an HTML file a navigation
    /// fetched (and the browser cached, with no `Vary: corten`) has it when it loads as the page. A relayed page
    /// keeps the policy it brought, as it keeps its CSP. Lines the app's middleware or handler sets
    /// go after Corten's: the browser reads the lines as one list in which a feature's last entry
    /// counts, so they deny more (`fullscreen=()`) and cannot undo a denial without saying so.
    /// `swap`: the request was the runtime's (a navigation or a patch), so its answer may be one
    /// it draws into the page; any other request's answer loads as what it is, whatever it says.
    pub(crate) fn document(&self, res: &mut Response, csp: &Csp, swap: bool) {
        if !self.adds_to_documents(csp) {
            return;
        }
        let headers = res.headers();
        if swap && (headers.contains_key(crate::page::PAGE_HEADER) || headers.contains_key(crate::page::PATCH_HEADER)) {
            return;
        }
        if !headers.get(header::CONTENT_TYPE).is_some_and(|kind| html(kind.as_bytes())) {
            // The service worker's script is held to its CSP too, and takes its endpoints from
            // its own answer.
            if let Some(reporting) = &self.reporting {
                if res.extensions().get::<crate::pwa::WorkerScript>().is_some() {
                    endpoints(res, reporting);
                }
            }
            return;
        }
        // Where its CSP's reports go ([`Policy::report_to`]): a document keeps the endpoints it
        // loaded with, as it keeps its policy, so a navigation's answer needs none.
        if let Some(reporting) = &self.reporting {
            endpoints(res, reporting);
        }
        let Some(permissions) = &csp.permissions else {
            return;
        };
        if let http::header::Entry::Vacant(entry) = res.headers_mut().entry(PERMISSIONS_POLICY) {
            entry.insert(permissions.clone());
            return;
        }
        ours_first(res, permissions);
    }

    /// A relayed page keeps the policy its own HTML was written for (its scripts' nonces and
    /// hosts), which the app's would block. Out of [`Applied::headers`], which every response runs.
    /// Whether it kept it.
    #[cold]
    #[inline(never)]
    fn keep_relayed(&self, res: &mut Response, brought: HeaderValue) -> bool {
        if res.extensions().get::<crate::answer::Relayed>().is_some() {
            let name =
                if self.report_only { header::CONTENT_SECURITY_POLICY_REPORT_ONLY } else { header::CONTENT_SECURITY_POLICY };
            res.headers_mut().insert(name, brought);
            return true;
        }
        false
    }
}

/// The policy an answer brought, every line of it, where it sends no more than `ours`: the least
/// of both. One the browser would not know is ours.
#[cold]
#[inline(never)]
fn stricter_referrer(mut entry: http::header::OccupiedEntry<'_, HeaderValue>, ours: Sent) {
    let theirs = Sent::parse(entry.iter());
    entry.insert(theirs.map_or(ours, |theirs| ours.and(theirs)).header());
}

/// True when the request's `Origin` is one of `origins` and it carries no cookies: a site allowed
/// for an API authenticates with a token, so a write it sends with the user's cookies (a
/// `SameSite=None` session and `credentials: "include"`) is refused like any cross-site write.
pub(crate) fn allowed(headers: &HeaderMap, origins: &[String]) -> bool {
    !origins.is_empty()
        && !headers.contains_key(header::COOKIE)
        && headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|origin| origins.iter().any(|o| o.eq_ignore_ascii_case(origin.trim_end_matches('/'))))
}

impl Policy {
    /// CSRF check for writes. Every current browser sends `Sec-Fetch-Site`, which page script
    /// cannot set: `same-origin` is accepted as is (so a proxy that rewrites `Host` cannot break
    /// writes) and anything cross-site is refused. A browser sends it only to a secure origin
    /// (and Chromium and Firefox not on a WebSocket handshake); older browsers not at all. Then
    /// `Origin` must be an `http` or `https` origin on the requested authority (the target's,
    /// or the `Host` line when the target has none): the same name and port (a missing
    /// one is the scheme's default), and over `https`, or on loopback, when the app is HTTPS only
    /// ([`Policy::hsts`]). A request with neither header is not from a browser (a native app, an
    /// agent, a webhook); those authenticate with tokens, not ambient cookies, so it passes.
    /// Pass the request's URI as received: a path-only URI compares `Origin` with `Host`
    /// even if the original target had an authority.
    pub fn same_origin(&self, method: &Method, uri: &http::Uri, headers: &HeaderMap) -> bool {
        if !Origin::checks(method) {
            return true;
        }
        write_allowed(&self.allowed_origins, self.hsts, uri, headers)
    }

    /// The other origins [`Policy::allow_origin`] lets write.
    pub(crate) fn allowed_origins(&self) -> &[String] {
        &self.allowed_origins
    }

    /// Whether the app said it is HTTPS only ([`Policy::hsts`]).
    pub(crate) fn sends_hsts(&self) -> bool {
        self.hsts
    }
}

/// Whether a write with `headers` comes from the app's own pages, one of `allowed` (lowercase
/// origins), or a client that is not a browser: [`Policy::same_origin`] past its methods, and
/// what a switch to a WebSocket is held to ([`crate::upgrade::Upgrade`]). `https_only`: the app
/// is served only over HTTPS ([`Policy::hsts`]).
pub(crate) fn write_allowed(allowed: &[String], https_only: bool, uri: &http::Uri, headers: &HeaderMap) -> bool {
    Origin::new(headers).permits(allowed, https_only, uri)
}

/// The security checks' view of the original request. The host check, CORS and the debug form
/// check can use the same values without looking up their names again, even when a header is absent.
pub(crate) struct Origin<'a> {
    headers: &'a HeaderMap,
    value: Option<Option<&'a HeaderValue>>,
    site: Option<Option<&'a HeaderValue>>,
    host: Option<Option<&'a HeaderValue>>,
}

impl<'a> Origin<'a> {
    pub(crate) fn new(headers: &'a HeaderMap) -> Self {
        Self { headers, value: None, site: None, host: None }
    }

    pub(crate) fn value(&mut self) -> Option<&'a HeaderValue> {
        *self.value.get_or_insert_with(|| self.headers.get(header::ORIGIN))
    }

    fn site(&mut self) -> Option<&'a HeaderValue> {
        *self.site.get_or_insert_with(|| self.headers.get("sec-fetch-site"))
    }

    pub(crate) fn host(&mut self) -> Option<&'a HeaderValue> {
        *self.host.get_or_insert_with(|| self.headers.get(header::HOST))
    }

    /// [`host_lines`], with the line kept for [`Origin::host`].
    fn host_lines(&mut self) -> (Option<&'a HeaderValue>, bool) {
        let (host, more) = host_lines(self.headers);
        self.host = Some(host);
        (host, more)
    }

    fn checks(method: &Method) -> bool {
        !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
    }

    fn permits(&mut self, allowed: &[String], https_only: bool, uri: &http::Uri) -> bool {
        let origin = self.value().and_then(|v| v.to_str().ok()).map(|o| o.trim_end_matches('/').to_ascii_lowercase());
        if let Some(origin) = &origin {
            if allowed.iter().any(|allowed| allowed == origin) {
                return true;
            }
        }
        match self.site().map(HeaderValue::as_bytes) {
            // `none`: the user started it (typed URL, bookmark); no other site can cause it.
            Some(b"same-origin" | b"none") => return true,
            Some(_) => return false,
            None => {}
        }
        match origin {
            None => true,
            Some(origin) if origin == "null" => false,
            Some(origin) => origin_of_host(&origin, https_only, request_host(uri, || self.host())),
        }
    }
}

/// Whether `origin` (an `Origin` header) is a page's on the requested authority ([`on_host`]), over
/// `https` or loopback when the app is `https_only`. Without `https_only` the scheme is not
/// compared: behind a proxy that ends TLS the app cannot tell which it is served over, so a
/// plain-http page on its host passes (docs/design.md#limit-origin-scheme). Out of line: only a
/// request without `Sec-Fetch-Site` comes here.
#[cold]
#[inline(never)]
fn origin_of_host(origin: &str, https_only: bool, host: Option<RequestHost<'_>>) -> bool {
    let host = host.and_then(RequestHost::text).unwrap_or("");
    match on_host(origin, host) {
        Some(("https", _)) => true,
        Some((_, at)) => !https_only || loopback(at),
        None => false,
    }
}

/// `origin` (an `Origin` header) when it is a page's on the requested authority `host`: its scheme,
/// `http` or `https`, and its `host[:port]`. The name and port must be `host`'s, a port left out
/// being the scheme's default (`https://app.example` is on `app.example:443`). `None` for another
/// scheme (an app's own, `capacitor://localhost`, is no page on this host) or an origin with a
/// user, a path or a query, which no page's has (RFC 6454).
pub(crate) fn on_host<'a>(origin: &'a str, host: &str) -> Option<(&'static str, &'a str)> {
    let (scheme, at) = origin.trim_end_matches('/').split_once("://")?;
    let scheme = if scheme.eq_ignore_ascii_case("https") {
        "https"
    } else if scheme.eq_ignore_ascii_case("http") {
        "http"
    } else {
        return None;
    };
    if at.is_empty() || at.contains(['@', '/', '\\', '?', '#']) {
        return None;
    }
    // `name:` is the name on the default port too.
    fn bare<'s>(scheme: &str, at: &'s str) -> &'s str {
        without_default_port(Some(scheme), at.strip_suffix(':').unwrap_or(at))
    }
    bare(scheme, at).eq_ignore_ascii_case(bare(scheme, host)).then_some((scheme, at))
}

/// `origin`, a setting naming another origin ([`Policy::allow_origin`],
/// [`crate::Api::allow_origin`]), as a browser writes it in `Origin`, which a request's is
/// compared with as it is; a startup panic naming `setting` when it is not one origin.
pub(crate) fn allowed_origin(setting: &str, origin: &str) -> String {
    match serialize_origin(origin) {
        Ok(serialized) => serialized,
        Err(NotOrigin::NonAsciiName) => panic!(
            "corten: {setting} takes one origin with an ASCII name, as a browser sends it in Origin, not {origin:?}: write the name in its xn-- (punycode) form"
        ),
        Err(NotOrigin::Form) => panic!(
            "corten: {setting} takes one origin, a scheme and a host with an optional port, like https://partner.example or capacitor://localhost (no path, query, user, wildcard or list), not {origin:?}"
        ),
        Err(NotOrigin::NeverSent { scheme, why }) => panic!(
            "corten: {setting} takes one origin a browser sends in Origin, not {origin:?}: no browser sends a {scheme}: origin, since {why} (docs/design.md#choice-allowed-origin-schemes)"
        ),
    }
}

/// Why a setting is not an origin [`serialize_origin`] can write.
#[derive(Debug, PartialEq)]
enum NotOrigin {
    /// Not `scheme://host[:port]`, or a part of it is malformed.
    Form,
    /// The name is well formed but for letters outside ASCII, which a browser sends as `xn--`.
    NonAsciiName,
    /// A scheme no `Origin` ever carries, with why.
    NeverSent { scheme: &'static str, why: &'static str },
}

/// `scheme` (lowercase) and why a browser never sends it in `Origin`, for one it never does.
fn never_an_origin(scheme: &str) -> Option<(&'static str, &'static str)> {
    const NULL: &str = "a page loaded from it sends Origin: null";
    const FILE: &str = "a browser sends Origin: null from it, and file:// would name every local file, not one app (an Electron app registers a standard scheme)";
    const CREATOR: &str = "a document from it has the origin of the page that made it";
    const NO_PAGE: &str = "no page is served from it";
    Some(match scheme {
        "file" => ("file", FILE),
        "data" => ("data", NULL),
        "blob" => ("blob", CREATOR),
        "javascript" => ("javascript", CREATOR),
        "about" => ("about", CREATOR),
        "ws" => ("ws", NO_PAGE),
        "wss" => ("wss", NO_PAGE),
        "ftp" => ("ftp", NO_PAGE),
        _ => return None,
    })
}

/// `origin` serialized as RFC 6454 section 6.1 and the URL Standard's origin serializer write it
/// for `http` and `https`: the scheme, `://`, the host and `:port` unless the port is the
/// scheme's default. Another scheme (RFC 3986 section 3.1: a letter, then letters, digits, `+`,
/// `-` and `.`) is kept the same way but with every port written, as an app's webview or a
/// browser extension sends it (`capacitor://localhost`, `chrome-extension://<id>`;
/// docs/design.md#choice-allowed-origin-schemes), except the schemes no `Origin` carries
/// ([`never_an_origin`]: `file`, `data`, `blob`, `javascript`, `about`, `ws`, `wss` and
/// `ftp`). The scheme and a name are lowercased, an
/// address written in its standard form and the port as a number, and one trailing `/` is
/// allowed. An error for anything else: no host, a user, a path, a query, a fragment, a name with
/// other than letters, digits, `-`, `_` and `.`, a name ending in a number that is not an IPv4
/// address, or a port that is not one.
fn serialize_origin(origin: &str) -> Result<String, NotOrigin> {
    let origin = origin.strip_suffix('/').unwrap_or(origin);
    let (scheme, rest) = origin.split_once(':').ok_or(NotOrigin::Form)?;
    if !is_scheme(scheme) {
        return Err(NotOrigin::Form);
    }
    let scheme = scheme.to_ascii_lowercase();
    if let Some((scheme, why)) = never_an_origin(&scheme) {
        return Err(NotOrigin::NeverSent { scheme, why });
    }
    let at = rest.strip_prefix("//").ok_or(NotOrigin::Form)?;
    let default_port = match scheme.as_str() {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    };
    let (host, port) = split_port(at);
    let host = match host.strip_prefix('[') {
        Some(address) => {
            let address: std::net::Ipv6Addr =
                address.strip_suffix(']').and_then(|address| address.parse().ok()).ok_or(NotOrigin::Form)?;
            match address.to_ipv4_mapped() {
                // Rust writes these `::ffff:1.2.3.4`; the URL Standard writes every piece in hex.
                Some(_) => {
                    let pieces = address.segments();
                    format!("[::ffff:{:x}:{:x}]", pieces[6], pieces[7])
                }
                None => format!("[{address}]"),
            }
        }
        None => {
            let name = host.to_ascii_lowercase();
            let labels = name.strip_suffix('.').unwrap_or(&name);
            let letter = |b: u8| b.is_ascii_alphanumeric() || b == b'-' || b == b'_';
            if labels.split('.').any(|label| label.is_empty() || !label.bytes().all(letter)) {
                // Wrong only for its letters outside ASCII: a name its author wrote in Unicode.
                let unicode = !labels.is_ascii()
                    && labels.split('.').all(|label| !label.is_empty() && label.bytes().all(|b| !b.is_ascii() || letter(b)));
                return Err(if unicode { NotOrigin::NonAsciiName } else { NotOrigin::Form });
            }
            // A name whose last label is a number is an IPv4 address to a browser.
            if labels.rsplit('.').next().is_some_and(|last| last.bytes().all(|b| b.is_ascii_digit())) {
                labels.parse::<std::net::Ipv4Addr>().map_err(|_| NotOrigin::Form)?.to_string()
            } else {
                name
            }
        }
    };
    let port = match port {
        None => None,
        Some(port) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            let port: u16 = port.parse().map_err(|_| NotOrigin::Form)?;
            (Some(port) != default_port).then_some(port)
        }
        Some(_) => return Err(NotOrigin::Form),
    };
    Ok(match port {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

/// Whether `at` (`host[:port]`) is loopback, which a browser counts as secure over plain `http`:
/// `localhost`, a name under it, `127.0.0.0/8` or `[::1]`.
pub(crate) fn loopback(at: &str) -> bool {
    let (host, _) = split_port(at);
    if host.starts_with('[') {
        return host == "[::1]";
    }
    let host = host.strip_suffix('.').unwrap_or(host).as_bytes();
    host.eq_ignore_ascii_case(b"localhost")
        || (host.len() > 10 && host[host.len() - 10..].eq_ignore_ascii_case(b".localhost"))
        || std::str::from_utf8(host).ok().and_then(|h| h.parse::<std::net::Ipv4Addr>().ok()).is_some_and(|ip| ip.is_loopback())
}

/// What a request's target and `Host` say of it, before anything of the app runs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Asked {
    /// For a host the app answers to, or for none it has to name.
    Here,
    /// For a host that is not the app's: `421`.
    Elsewhere,
    /// Not a request HTTP allows: `400`.
    Malformed,
}

impl Asked {
    /// The answer to a request that goes no further, with a few words for a person who reads it.
    /// Either is Corten's refusal ([`crate::cache::Unshared`]), for an app that relays it inline too.
    ///
    /// The `400` leaves the connection open, as the `421` does and as RFC 9112 lets it: the
    /// server read the message's head and knows where its body ends, so the next request on the
    /// connection is read as it would be after any other answer (9.3), and hyper closes one whose
    /// request body it cannot finish reading, as after any answer that leaves a body unread. The
    /// sections that have a server close after a `400` are those where the message's length is
    /// in doubt (6.1, 6.3), and hyper answers those itself, as it does a request-line it cannot
    /// parse (a target that is not UTF-8): its own `400`, and the connection closed.
    #[inline]
    pub(crate) fn refusal(self) -> Option<Response> {
        match self {
            Asked::Here => None,
            Asked::Elsewhere => {
                Some(crate::cache::unshared((StatusCode::MISDIRECTED_REQUEST, "Misdirected request.").into_response()))
            }
            Asked::Malformed => Some(crate::cache::unshared((StatusCode::BAD_REQUEST, "Bad request.").into_response())),
        }
    }
}

/// The authority in its borrowed form. Host admission checks the original bytes of a line;
/// origin comparisons use text, and a write can keep the authority for its answer.
#[derive(Clone, Copy)]
pub(crate) enum RequestHost<'a> {
    Target(&'a http::uri::Authority),
    Line(&'a HeaderValue),
}

impl<'a> RequestHost<'a> {
    pub(crate) fn text(self) -> Option<&'a str> {
        match self {
            Self::Target(at) => Some(at.as_str()),
            Self::Line(line) => line.to_str().ok(),
        }
    }

    pub(crate) fn into_header(self) -> Option<HeaderValue> {
        match self {
            Self::Target(at) => HeaderValue::from_bytes(at.as_str().as_bytes()).ok(),
            Self::Line(line) => Some(line.clone()),
        }
    }
}

/// The authority a request asks for, port included (RFC 9112 3.2.2). `line` can return the
/// value already read while checking the Host line's grammar; it is not needed for a whole URL.
#[inline]
pub(crate) fn request_host<'a>(uri: &'a http::Uri, line: impl FnOnce() -> Option<&'a HeaderValue>) -> Option<RequestHost<'a>> {
    match uri.authority() {
        Some(at) => Some(RequestHost::Target(at)),
        None => line().map(RequestHost::Line),
    }
}

/// A request's `Host` line, and whether it has another. Most requests have one line to a name,
/// which the map's two counts say without a look at any of them, and `Host` first, where a
/// client writes it (RFC 9110 7.2 asks it to), so the line is taken without a search for it.
#[inline]
fn host_lines(headers: &HeaderMap) -> (Option<&HeaderValue>, bool) {
    if headers.len() == headers.keys_len() {
        return match headers.iter().next() {
            Some((name, host)) if name == header::HOST => (Some(host), false),
            _ => (headers.get(header::HOST), false),
        };
    }
    let mut lines = headers.get_all(header::HOST).iter();
    let host = lines.next();
    (host, lines.next().is_some())
}

/// What `req` asks for ([`Asked`]): `lines` gives its `Host` line and whether it has another,
/// and `hosts` is the names the app answers to, or `None` when it answers to any.
///
/// What RFC 9112 3.2 has a server answer `400`: more than one `Host` line, a `Host` that is not
/// a host and maybe a port, and an HTTP/1.1 message with no `Host` line. Of the request-target
/// one part is read, and held to the same: the host and port of a target that names its own
/// ([`targeted`]), which is the host the request asks for, so it is read where `Host` would be
/// and one that is no host and maybe a port is a `400` too, by Corten's choice. Nothing else of
/// a target is read or refused here: what the same section says a server should answer `400`
/// or a redirect, an invalid request-line (a byte no URI holds, as the parse lets through a
/// `|`, a `%` before no hex and a byte outside ASCII that is UTF-8), is answered as before,
/// and so are `*` with a method other than `OPTIONS` (3.2.4 names no answer) and a target
/// that is a host alone with a method other than `CONNECT` (3.2.3). The `Host` is read once
/// for these and for the names, so a request the app answers costs a look at whether any name
/// has two lines and the read of its `Host`.
#[inline]
fn asked<'h>(req: &Request, lines: impl FnOnce() -> (Option<&'h HeaderValue>, bool), hosts: Option<&[String]>) -> Asked {
    match read(req, lines, hosts) {
        Asked::Malformed => malformed(req),
        asked => asked,
    }
}

#[inline]
fn read<'h>(req: &Request, lines: impl FnOnce() -> (Option<&'h HeaderValue>, bool), hosts: Option<&[String]>) -> Asked {
    let (host, more) = lines();
    if more {
        return Asked::Malformed;
    }
    // Keep the path-form check inline on unstaged routes; the choice of authority must agree with `request_host`.
    match (req.uri().authority(), host) {
        (None, Some(host)) => match hosts {
            Some(names) => among(host.as_bytes(), names),
            None => any(host.as_bytes()),
        },
        (None, None) => unnamed(req),
        (Some(target), host) => targeted(target.as_str(), host, req, hosts),
    }
}

/// Logs the first request of the process refused for each reason HTTP does not allow one
/// ([`Refused`]): a health check written by hand, or a proxy that sends a second `Host`, is as
/// likely to send one as a scanner is, and its `400`s take the app out of service with nothing
/// else to say why. One line a reason, so a request refused for one does not use up the line of
/// a request refused for another; a later one costs the look for its reason and no more.
#[cold]
#[inline(never)]
fn malformed(req: &Request) -> Asked {
    use std::sync::atomic::AtomicBool;
    static LOGGED: [AtomicBool; Refused::COUNT] = [const { AtomicBool::new(false) }; Refused::COUNT];
    if let Some(line) = Refused::first(req, &LOGGED) {
        tracing::warn!("{line}");
    }
    Asked::Malformed
}

/// Why [`read`] refused a request, in the order it looks.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Refused {
    /// More than one `Host` line.
    Lines,
    /// An HTTP/1.1 message the server read with no `Host` line.
    Unnamed,
    /// A `Host` that is not a host and maybe a port.
    Host,
    /// A target whose own host is not one.
    TargetHost,
}

impl Refused {
    /// How many reasons there are, counted from the last. A reason added is named here, or this
    /// does not compile, so the one who adds it sees that the last is the one counted from.
    const COUNT: usize = {
        let last = Refused::TargetHost;
        match last {
            Refused::Lines | Refused::Unnamed | Refused::Host | Refused::TargetHost => last as usize + 1,
        }
    };

    /// The log's line for `req` when it is the first refused for its reason that `logged` has
    /// seen, and nothing for a later one.
    fn first(req: &Request, logged: &[std::sync::atomic::AtomicBool; Refused::COUNT]) -> Option<String> {
        let reason = Refused::of(req);
        let first = !logged[reason as usize].swap(true, std::sync::atomic::Ordering::Relaxed);
        first.then(|| reason.line(req))
    }

    fn of(req: &Request) -> Refused {
        let mut hosts = req.headers().get_all(header::HOST).iter();
        match (hosts.next(), hosts.next()) {
            (_, Some(_)) => Refused::Lines,
            (None, _) if req.extensions().get::<Unnamed>().is_some() => Refused::Unnamed,
            (Some(host), _) if named(host.as_bytes(), None) == Asked::Malformed => Refused::Host,
            _ => Refused::TargetHost,
        }
    }

    /// The log's line for `req`: its method, its path and the reason. Never its query, a user
    /// in its target or in a `Host`, or what follows a `/` or a `?` there, any of which may hold
    /// what no log should; of a host only what names it. A `Host` that is none for another
    /// reason (a space in it, a port that is no number) is given as sent: an operator needs it
    /// to see what sends it.
    /// The method, the path and the host are given by their start ([`start`]), so a long
    /// request does not make a long line.
    fn line(self, req: &Request) -> String {
        /// What a `Host` or an authority names, without a user before it or a path after it.
        /// Nothing where an `@` follows a `/`, `?` or `#`: it may end a user whose password
        /// holds one, or be in a path or a query, and neither reading is safe to print.
        fn names(host: &[u8]) -> String {
            let host = String::from_utf8_lossy(host);
            let (host, after) = host.split_at(host.find(['/', '?', '#']).unwrap_or(host.len()));
            if after.contains('@') {
                return String::new();
            }
            format!(" (it names {})", start(host.rsplit('@').next().unwrap_or_default()))
        }
        let why = match self {
            Refused::Lines => {
                format!("it has {} Host lines, and HTTP allows one", req.headers().get_all(header::HOST).iter().count())
            }
            Refused::Unnamed => {
                "it is HTTP/1.1 with no Host line: a client, a health check too, sends one or asks as HTTP/1.0".to_owned()
            }
            Refused::Host => {
                let host = req.headers().get(header::HOST).map(|host| names(host.as_bytes())).unwrap_or_default();
                format!("its Host is not a host and maybe a port alone{host}")
            }
            Refused::TargetHost => {
                let host = req.uri().authority().map(|target| names(target.as_str().as_bytes())).unwrap_or_default();
                format!("its request-target's host is not a host and maybe a port alone{host}")
            }
        };
        // A method is a token, which needs no quotes: only one too long for a line is cut.
        let method = req.method().as_str();
        let method = if method.len() > LOGGED_BYTES { start(method) } else { method.to_owned() };
        format!("corten: refused {method} {} (400): {why}", start(req.uri().path()))
    }
}

/// `text` as a log line gives it, in quotes and escaped: all of it, or its first
/// [`LOGGED_BYTES`] bytes (fewer where that would cut a character) and that it goes on. A
/// method, a path and a `Host` can each be as long as a request's head may be, and a line of
/// the log is read by a person.
fn start(text: &str) -> String {
    if text.len() <= LOGGED_BYTES {
        return format!("{text:?}");
    }
    let mut end = LOGGED_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{:?}... ({} bytes)", &text[..end], text.len())
}

/// How much of a method, a path or a host a refused request's log line gives.
const LOGGED_BYTES: usize = 200;

/// On a request Corten's server read off a connection as an HTTP/1.1 message with no `Host`
/// line ([`mark_unnamed`]). A layer of the app's that maps the request's body or moves it to
/// another task keeps it; one that builds a request of its own and leaves the extensions behind
/// loses it, as it does the connection's values the server put there. A test's request, and one
/// a server of the app's own hands the router, never has it.
#[derive(Clone, Copy)]
pub(crate) struct Unnamed;

/// Marks `req`, which the server has just read off a connection, when it is an HTTP/1.1 message
/// with no `Host` line: only the server knows that of a request, and the host check answers it
/// ([`unnamed`]). A client writes `Host` first (RFC 9110 7.2 asks it to), so the first name is
/// looked at first, and only a request without one is given the mark. Where `Host` is not
/// first it is most often near it, so the names are read in turn and not searched by hash.
#[inline]
pub(crate) fn mark_unnamed(req: &mut Request) {
    if req.headers().keys().next() != Some(&header::HOST) {
        mark_if_unnamed(req);
    }
}

#[cold]
#[inline(never)]
fn mark_if_unnamed(req: &mut Request) {
    if req.version() == http::Version::HTTP_11 && !req.headers().keys().any(|name| name == header::HOST) {
        req.extensions_mut().insert(Unnamed);
    }
}

/// A request with no `Host` line: HTTP/1.0's is for the app, and so is one Corten's server did
/// not read off a connection (a test's, which has no host to name; one from a server of the
/// app's own, which answers for what it read). An HTTP/1.1 message the server read is not one
/// HTTP allows, and carries its mark ([`Unnamed`]).
#[cold]
#[inline(never)]
fn unnamed(req: &Request) -> Asked {
    match req.extensions().get::<Unnamed>() {
        Some(Unnamed) => Asked::Malformed,
        None => Asked::Here,
    }
}

/// A request whose target names its host (`GET http://shop.example/ HTTP/1.1`, or `CONNECT`'s
/// `shop.example:443`): the target's is the host asked for, whatever `Host` says (RFC 9112
/// 3.2.2), but the message still needs its one `Host` line, with a host in it (3.2). `target` is
/// the whole authority, and one with a user in it, a port that is no number or an address in
/// brackets that is not IPv6 is refused as the same bytes in `Host` are, by Corten's choice:
/// RFC 9110 4.2.4 says a recipient should treat a user there as an error, and 9112 3.2 that a
/// server should answer an invalid request-target with a `400` or a redirect, each less than
/// 3.2 says of `Host`. It is the one part of a target read here, since it is the name asked for.
#[cold]
#[inline(never)]
fn targeted(target: &str, host: Option<&HeaderValue>, req: &Request, hosts: Option<&[String]>) -> Asked {
    let line = match host {
        Some(host) => named(host.as_bytes(), None),
        None => unnamed(req),
    };
    match line {
        Asked::Here => named(target.as_bytes(), hosts),
        refused => refused,
    }
}

/// What `host` names (a `Host` header, or a target's host: a name or an address, and maybe a
/// port): [`Asked::Here`] for `localhost` or a name under it, an IP address, or one of `names`
/// (`.name`: it and its subdomains), and for any host when there are no names to hold it to;
/// [`Asked::Malformed`] when it is not RFC 9110 7.2's `uri-host [ ":" port ]`, with RFC 3986
/// 3.2.2's host. That grammar allows a name of no bytes, and RFC 9112 3.3 lets a server put its
/// own default name in its place; Corten has none to put there, and an `http` URI with an empty
/// host is one a recipient rejects (RFC 9110 4.2.1), so here a `Host` of no bytes is malformed
/// too, by choice and not by 3.2. An address in brackets is IPv6: 3986's `IPvFuture` has no
/// version defined, and its text asks for an error; a zone (`[fe80::1%25eth0]`) is not in its
/// grammar since RFC 9844 took back RFC 6874, which had put it there.
///
/// A name the app answers to as it is written (`localhost`, an IPv4 address, a name in
/// `names`) is a `reg-name` since what it matched is one, so what is read byte by byte is only
/// the part before a name the app holds subdomains under, a name it does not hold, and any name
/// when it has none. A name refused as another host's is logged.
fn named(host: &[u8], names: Option<&[String]>) -> Asked {
    match names {
        Some(names) => among(host, names),
        None => any(host),
    }
}

/// [`named`] with no names to hold the host to: whether it is a host and maybe a port at all.
/// Every request to an app that answers to any host comes here, so it is in line where the
/// request is read, and a `Host` of a name's own characters and a port is read once, its port
/// from the end and a name of letters, digits, `-` and `.` sixteen bytes at a look
/// ([`without_port`], [`reg_name`]).
#[inline(always)]
fn any(host: &[u8]) -> Asked {
    // `[::1]:3000`: an IPv6 address is always in brackets.
    if host.first() == Some(&b'[') {
        return if ip_literal(host) { Asked::Here } else { Asked::Malformed };
    }
    if reg_name(without_port(host)) {
        Asked::Here
    } else {
        Asked::Malformed
    }
}

/// `host` without its port: what is before its last colon when digits alone follow it (or
/// nothing: `shop.example:` has an empty port), and all of `host` when it has no colon or
/// something else follows its last one. It is read from the end, where a port is a few bytes,
/// and not searched for a colon from the start, so the name's bytes are read by whoever reads
/// the name and not here as well. A colon that is no port's is left in what this gives, and
/// neither a `reg-name` nor a name the app answers to holds one, so [`any`] and [`among`] find
/// such a `Host` malformed by the name's own rule.
#[inline]
fn without_port(host: &[u8]) -> &[u8] {
    let mut name = host;
    while let [rest @ .., b'0'..=b'9'] = name {
        name = rest;
    }
    match name {
        [name @ .., b':'] => name,
        _ => host,
    }
}

/// [`named`] in an app that names its hosts.
fn among(host: &[u8], names: &[String]) -> Asked {
    // `[::1]:3000`: an IPv6 address is always in brackets.
    if host.first() == Some(&b'[') {
        return if ip_literal(host) { Asked::Here } else { Asked::Malformed };
    }
    let name = without_port(host);
    let bare = name.strip_suffix(b".").unwrap_or(name);
    if bare.eq_ignore_ascii_case(b"localhost") {
        return Asked::Here;
    }
    // An IPv4 address: digits and dots, which no DNS name a browser resolves is.
    if !bare.is_empty() && bare.iter().all(|&b| b.is_ascii_digit() || b == b'.') {
        if std::str::from_utf8(bare).is_ok_and(|n| n.parse::<std::net::Ipv4Addr>().is_ok()) {
            return Asked::Here;
        }
        refused_host(host);
        return Asked::Elsewhere;
    }
    // How much of the name's end is a name the app holds its subdomains under.
    let mut held = if ends_with(bare, b".localhost") { Some(".localhost".len()) } else { None };
    for allowed in names {
        match allowed.strip_prefix('.') {
            Some(domain) if bare.eq_ignore_ascii_case(domain.as_bytes()) => return Asked::Here,
            Some(_) if ends_with(bare, allowed.as_bytes()) => held = Some(allowed.len()),
            None if bare.eq_ignore_ascii_case(allowed.as_bytes()) => return Asked::Here,
            _ => {}
        }
    }
    match held {
        Some(held) if reg_name(&bare[..bare.len() - held]) => Asked::Here,
        None if reg_name(name) => {
            refused_host(host);
            Asked::Elsewhere
        }
        _ => Asked::Malformed,
    }
}

fn ends_with(name: &[u8], suffix: &[u8]) -> bool {
    name.len() > suffix.len() && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// Whether `name` is a `reg-name` (RFC 3986 3.2.2) of at least one byte: unreserved characters,
/// sub-delimiters and percent-encoded bytes. No colon, so a second one in a `Host` is not a port's.
#[inline(always)]
fn reg_name(name: &[u8]) -> bool {
    // A name of 8 to 16 bytes, of the letters, digits, `-` and `.` most names are made of, is
    // read in line sixteen bytes at a look, as its first eight and its last eight (which overlap
    // in a name shorter than 16). Any other name is read out of line ([`spelled`]).
    match (name.first_chunk::<8>(), name.last_chunk::<8>()) {
        (Some(first), Some(last)) if name.len() <= 16 && unlike_a_name(first) | unlike_a_name(last) == 0 => true,
        _ => spelled(name),
    }
}

/// [`reg_name`] for a name it does not read in line: one longer than 16 bytes of letters,
/// digits, `-` and `.` alone sixteen at a look ([`plain`]); a shorter one, and one with any
/// other byte, by the table below, which says the same of these. The table reads on from the
/// first byte no look before the one that found another byte read ([`plain`]), as the bytes
/// before it are a name's as written and none is `%`.
#[inline(never)]
fn spelled(name: &[u8]) -> bool {
    spelled_by(name, encoded)
}

/// [`spelled`], with the reader of percent-encoded bytes given ([`encoded`]; a test sees the
/// bytes it is given: only those no look before the one that found another byte read).
#[inline(always)]
fn spelled_by(name: &[u8], encoded: impl FnOnce(&[u8]) -> bool) -> bool {
    let from = match plain(name, unlike_a_name) {
        Ok(()) => return true,
        Err(from) => from,
    };
    let unread = &name[from..];
    // Few names hold a percent-encoded byte, so the name is read first for the bytes it holds
    // as they are, four to a look and then the one to three left over: a look at four costs
    // little more than a look at one, and a name is some tens of bytes.
    let written = |byte: &u8| AS_WRITTEN[usize::from(*byte)];
    let (fours, rest) = unread.as_chunks::<4>();
    if fours.iter().all(|[a, b, c, d]| written(a) & written(b) & written(c) & written(d)) && rest.iter().all(written) {
        return !name.is_empty();
    }
    encoded(unread)
}

/// `Ok` when `name` is longer than 16 bytes and all letters, digits, `-` and `.`, each 16 from
/// its start and then the last 16, which overlap the one before, looked at by `unlike`
/// ([`unlike_a_name`]; a test counts the looks). It stops at the first look that finds another
/// byte and gives the first byte no earlier look read: where that look starts, or, when the last
/// 16 find it, the first byte after the whole sixteens, as the last 16 overlap the look before
/// (32 for a name of 40, whose last 16 start at 24). Every byte before it is one of those, so a
/// long `Host` is not read to its end before the table reads it, nor read again by the table up to
/// there; 0 for a name of 16 bytes or fewer, which it does not look at.
#[inline(always)]
fn plain(name: &[u8], mut unlike: impl FnMut(&[u8; 16]) -> u8) -> Result<(), usize> {
    let Some(last) = name.last_chunk::<16>().filter(|_| name.len() > 16) else { return Err(0) };
    let (sixteens, _) = name.as_chunks::<16>();
    match sixteens.iter().position(|each| unlike(each) != 0) {
        Some(at) => Err(at * 16),
        None if unlike(last) == 0 => Ok(()),
        // The last 16 found it, so it is among the bytes after the whole sixteens.
        None => Err(sixteens.len() * 16),
    }
}

/// Nonzero when any of `bytes` is not a letter, a digit, `-` or `.`. Each byte is looked at with
/// no early return, so the compiler reads them all at once: sixteen in one look, which two calls
/// for eight are joined into.
#[inline(always)]
fn unlike_a_name<const N: usize>(bytes: &[u8; N]) -> u8 {
    bytes.iter().fold(0, |unlike, &byte| {
        let digit = byte.wrapping_sub(b'0') < 10;
        let letter = (byte | 0x20).wrapping_sub(b'a') < 26;
        let dash_or_dot = byte.wrapping_sub(b'-') < 2;
        unlike | u8::from(!(digit | letter | dash_or_dot))
    })
}

/// The bytes a `reg-name` holds as they are: unreserved characters and sub-delimiters.
static AS_WRITTEN: [bool; 256] = {
    let mut bytes = [false; 256];
    let mut byte = 0;
    while byte < 256 {
        bytes[byte] = (byte as u8).is_ascii_alphanumeric() || matches!(byte as u8, b'-' | b'.' | b'_' | b'~');
        bytes[byte] |= matches!(byte as u8, b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=');
        byte += 1;
    }
    bytes
};

/// [`reg_name`] for a name with a byte it does not hold as written: whether each such byte
/// starts a percent-encoded one (`%` and two hex digits). Out of line: few names have one, and
/// a `Host` that is none ends here.
#[cold]
#[inline(never)]
fn encoded(name: &[u8]) -> bool {
    let mut rest = name;
    loop {
        rest = match rest {
            [] => break true,
            [byte, rest @ ..] if AS_WRITTEN[usize::from(*byte)] => rest,
            [b'%', high, low, rest @ ..] if high.is_ascii_hexdigit() && low.is_ascii_hexdigit() => rest,
            _ => break false,
        };
    }
}

/// Whether `host`, which starts with `[`, is an IPv6 address in brackets and maybe a port
/// (`[::1]`, `[::1]:3000`).
fn ip_literal(host: &[u8]) -> bool {
    let Some(end) = host.iter().position(|&b| b == b']') else { return false };
    let port = match &host[end + 1..] {
        [] => true,
        [b':', port @ ..] => port.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    port && std::str::from_utf8(&host[1..end]).is_ok_and(|address| address.parse::<std::net::Ipv6Addr>().is_ok())
}

/// Logs the first refused host of the process: a deployed app that has not listed its name
/// answers 421 to everyone, and this says why.
#[cold]
#[inline(never)]
fn refused_host(host: &[u8]) {
    static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!("{}", refused_host_line(host));
    }
}

/// The log's line for `host`, refused as another's: the name by its start ([`start`]), as a
/// request HTTP does not allow is logged.
fn refused_host_line(host: &[u8]) -> String {
    let host = start(&String::from_utf8_lossy(host));
    format!("corten: refused a request for host {host} (421): if the app is served under that name, list it with Policy::host")
}

/// [`Policy::asked`], held apart from the policy: the names the app answers to, or `None` when
/// it answers to any.
#[derive(Clone)]
pub(crate) struct HostCheck(Option<Arc<[String]>>);

impl HostCheck {
    pub(crate) fn asked(&self, req: &Request) -> Asked {
        // Decided first, so the read for an app that answers to any host holds no names. The
        // stages' check (`Policy::asked`) does not: there it made every staged request cost more
        // (docs/design.md#choice-fixed-stages).
        match self.0.as_deref() {
            None => asked(req, || host_lines(req.headers()), None),
            names => asked(req, || host_lines(req.headers()), names),
        }
    }
}

/// The `form-action` sources of the app's policy and of each area's that adds to it (innermost
/// prefix first).
#[cfg(debug_assertions)]
pub(crate) struct FormPolicy {
    /// The names given to [`Policy::host`], the app's own when a request names no host.
    names: Vec<String>,
    app: Vec<String>,
    areas: Vec<(&'static str, Vec<String>)>,
}

#[cfg(debug_assertions)]
impl FormPolicy {
    fn at(&self, path: &str) -> &[String] {
        self.areas.iter().find(|(prefix, _)| crate::api::under(prefix, path)).map_or(&self.app, |(_, sources)| sources)
    }
}

/// A write a form may have sent, as [`Applied::form_check`] kept it.
#[cfg(debug_assertions)]
#[derive(Clone)]
pub(crate) struct FormCheck {
    forms: Arc<FormPolicy>,
    uri: http::Uri,
    host: Option<HeaderValue>,
    origin: Option<HeaderValue>,
    referer: Option<HeaderValue>,
    site: Option<HeaderValue>,
    /// The runtime sent it (`data-patch`): the browser stops only the same form without
    /// JavaScript.
    pub(crate) action: bool,
}

#[cfg(debug_assertions)]
impl FormCheck {
    /// Where the form's page lets a submission go, when one of the app's pages sent it
    /// (`Sec-Fetch-Site: same-origin`, or an `Origin` on its host, or neither header, as a test
    /// or another client that is not a browser sends); a form on another site's page (an identity
    /// provider's `form_post`) is held to that page's policy, so `None`. A browser that sends no
    /// `Origin` (or `null`) does not say the page's origin, so it is not checked either. The
    /// form's page is the `Referer` when it says the page; otherwise it may be any of the app's
    /// pages, and the redirect may go wherever one of the app's policies allows.
    pub(crate) fn targets(&self) -> Option<FormTargets> {
        fn text(value: &Option<HeaderValue>) -> Option<&str> {
            value.as_ref().and_then(|v| v.to_str().ok())
        }
        let host = request_host(&self.uri, || self.host.as_ref())
            .and_then(RequestHost::text)
            .map(|at| at.rsplit_once('@').map_or(at, |(_, at)| at).to_ascii_lowercase());
        let origin = text(&self.origin).filter(|origin| *origin != "null").and_then(address);
        let ours = match &self.site {
            Some(site) => site.as_bytes() == b"same-origin" && origin.is_some(),
            None => match (&origin, &self.origin) {
                (Some(origin), _) => host.as_deref().is_some_and(|host| {
                    without_default_port(None, host) == without_default_port(origin.scheme.as_deref(), &origin.at)
                }),
                (None, None) => true,
                (None, Some(_)) => false,
            },
        };
        if !ours {
            return None;
        }
        // The page's origin: `Origin`, which a browser sends with every submission and a proxy
        // leaves as the visitor's, else the host the request names.
        let own = match origin {
            Some(origin) => Some(Own { scheme: origin.scheme, at: origin.at }),
            None => host.map(|at| Own { scheme: None, at }),
        };
        // A page under a referrer policy that sends only the origin (the app's, an area's, or one
        // the page sends itself) has a `Referer` of `/` wherever it is, so `/` names no page.
        let page = text(&self.referer)
            .and_then(address)
            // A test that names no host may still say the page.
            .filter(|page| own.as_ref().is_none_or(|own| own.is(page.scheme.as_deref(), &page.at)))
            .map(|page| page.path)
            .filter(|path| path != "/");
        let sources = match page {
            Some(path) => self.forms.at(&path).to_vec(),
            None => {
                let all = std::iter::once(&self.forms.app).chain(self.forms.areas.iter().map(|(_, sources)| sources));
                let mut sources: Vec<String> = all.flatten().cloned().collect();
                sources.sort_unstable();
                sources.dedup();
                sources
            }
        };
        let names = if own.is_none() { self.forms.names.clone() } else { Vec::new() };
        Some(FormTargets { sources, own, names })
    }
}

/// The origins a form on the page that sent a write may go to (`'self'` and its `form-action`
/// sources), which Chromium and WebKit also hold the redirects the submission follows to: a debug
/// build checks a write's redirect against them, so a test sees what the browser would stop.
#[cfg(debug_assertions)]
pub(crate) struct FormTargets {
    sources: Vec<String>,
    /// The page's origin, `'self'`.
    own: Option<Own>,
    /// When the request names no host (a test's): the app's names (`Policy::host`), on a web
    /// scheme's default port, count as `'self'`.
    names: Vec<String>,
}

/// An origin: its scheme when known, and its host and port, lowercase.
#[cfg(debug_assertions)]
#[derive(Clone)]
struct Own {
    scheme: Option<String>,
    at: String,
}

#[cfg(debug_assertions)]
impl Own {
    /// Whether an address over `scheme` (`None`: the page's own) at `at` is this origin, as
    /// CSP matches `'self'`: the same host and port, an `http` origin's `https` too.
    fn is(&self, scheme: Option<&str>, at: &str) -> bool {
        let scheme = scheme.or(self.scheme.as_deref());
        let scheme_ok = match (self.scheme.as_deref(), scheme) {
            (Some(ours), Some(theirs)) => ours == theirs || (ours == "http" && theirs == "https"),
            (None, theirs) => theirs.is_none_or(|theirs| matches!(theirs, "http" | "https")),
            (Some(_), None) => true,
        };
        scheme_ok && without_default_port(self.scheme.as_deref(), &self.at) == without_default_port(scheme, at)
    }
}

/// `host:port` without the port when it is `scheme`'s default.
fn without_default_port<'a>(scheme: Option<&str>, at: &'a str) -> &'a str {
    match (split_port(at), scheme) {
        ((host, Some(port)), Some(scheme)) if Some(port) == default_port(scheme) => host,
        // A host without a known scheme (`Host` alone): either web default.
        ((host, Some("80" | "443")), None) => host,
        _ => at,
    }
}

#[cfg(debug_assertions)]
impl FormTargets {
    /// Whether the page's `form-action` lets a submission be redirected to `to` (a `Location`):
    /// a path is `'self'`; another address must be the page's origin or match a source, as
    /// CSP matches one after a redirect (its path left out). An address that is not a URL with a
    /// host is not checked.
    pub(crate) fn allows(&self, to: &[u8]) -> bool {
        let Ok(to) = std::str::from_utf8(to) else { return true };
        let Some(to) = address(to) else { return true };
        if self.own.as_ref().is_some_and(|own| own.is(to.scheme.as_deref(), &to.at)) {
            return true;
        }
        // `https:done` on an https page is a path; on another scheme, `http:evil.example` is a host.
        let page = self.own.as_ref().and_then(|own| own.scheme.as_deref());
        if to.bare && page.is_none_or(|page| Some(page) == to.scheme.as_deref()) {
            return true;
        }
        let bare = without_default_port(to.scheme.as_deref(), &to.at);
        let named = |name: &String| match name.strip_prefix('.') {
            Some(domain) => bare == domain || bare.strip_suffix(name.as_str()).is_some_and(|sub| !sub.is_empty()),
            None => bare == name,
        };
        if to.scheme.as_deref().is_none_or(|scheme| matches!(scheme, "http" | "https")) && self.names.iter().any(named) {
            return true;
        }
        let (host, port) = split_port(&to.at);
        self.sources.iter().any(|source| source_allows(&source.to_ascii_lowercase(), to.scheme.as_deref(), page, host, port))
    }

    /// Whether the page's origin is not known (a test's request that names no host, in an app
    /// with no `Policy::host`), so an address on the app's own origin cannot be told apart.
    pub(crate) fn own_unknown(&self) -> bool {
        self.own.is_none() && self.names.is_empty()
    }

    /// The origin of `to`, an address with a host, as a `form-action` source names it.
    pub(crate) fn origin(&self, to: &[u8]) -> String {
        let to = std::str::from_utf8(to).ok().and_then(address);
        let page = self.own.as_ref().and_then(|own| own.scheme.as_deref());
        match to {
            Some(to) => match to.scheme.as_deref().or(page) {
                Some(scheme) => format!("{scheme}://{}", to.at),
                None => format!("https://{}", to.at),
            },
            None => String::new(),
        }
    }
}

/// An address with a host, as a browser reads a `Location`.
#[cfg(debug_assertions)]
struct Address {
    /// `None` for one that starts `//`, which keeps the page's scheme.
    scheme: Option<String>,
    /// Its host and port, lowercase, without user info.
    at: String,
    /// Its path, `/` when it has none.
    path: String,
    /// Written `http:host`, with no slashes: a page on the same scheme reads it as a path.
    bare: bool,
}

/// Whether `to` (a `Location`) is an address with a host, which a form's page may not allow.
#[cfg(debug_assertions)]
pub(crate) fn is_address(to: &[u8]) -> bool {
    std::str::from_utf8(to).ok().and_then(address).is_some()
}

/// `to` as an [`Address`], or `None` for a path, an address with no host (`mailto:`) or one
/// the browser would read against the page (`https:done`). A backslash is a slash, as browsers
/// read one in an `http` address.
#[cfg(debug_assertions)]
fn address(to: &str) -> Option<Address> {
    // A browser strips the spaces and control characters around an address.
    let to = to.trim_matches(|c: char| c <= ' ');
    let slash = |c: char| c == '/' || c == '\\';
    let (scheme, rest) = match to.strip_prefix(slash).and_then(|rest| rest.strip_prefix(slash)) {
        Some(rest) => (None, rest),
        None => {
            let (scheme, rest) = to.split_once(':')?;
            if !is_scheme(scheme) {
                return None;
            }
            let scheme = scheme.to_ascii_lowercase();
            let rest = if matches!(scheme.as_str(), "http" | "https" | "ws" | "wss") {
                rest.trim_start_matches(slash)
            } else {
                rest.strip_prefix("//")?
            };
            (Some(scheme), rest)
        }
    };
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let (at, after) = rest.split_at(end);
    let at = at.rsplit_once('@').map_or(at, |(_, at)| at).to_ascii_lowercase();
    let path = after.split(['?', '#']).next().unwrap_or("").replace('\\', "/");
    let path = if path.is_empty() { "/".to_owned() } else { path };
    // Fewer than two slashes after the scheme: on a page of that scheme, a path.
    let bare = scheme.is_some() && to.split_once(':').is_some_and(|(_, rest)| rest.chars().take_while(|&c| slash(c)).count() < 2);
    (!at.is_empty()).then_some(Address { scheme, at, path, bare })
}

fn is_scheme(scheme: &str) -> bool {
    scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

/// `host:port` as its host and port (`[::1]:3000`, `*.example.com:*`).
fn split_port(at: &str) -> (&str, Option<&str>) {
    let colon =
        if at.starts_with('[') { at.find(']').and_then(|end| at[end..].find(':').map(|c| end + c)) } else { at.rfind(':') };
    match colon {
        Some(colon) => (&at[..colon], Some(&at[colon + 1..])),
        None => (at, None),
    }
}

fn default_port(scheme: &str) -> Option<&'static str> {
    match scheme {
        "http" | "ws" => Some("80"),
        "https" | "wss" => Some("443"),
        _ => None,
    }
}

/// Whether CSP source expression `source` (lowercase) matches a redirect to `host` and `port`
/// over `scheme` (`None`: an address that starts `//`) from a page over `page` (`None`: not
/// known): a scheme (`https:`), `*`, or a host with a scheme, a `*.` wildcard and a port where
/// it has them (CSP 3, 6.7.2.8; after a redirect a source's path is not matched). `http` also
/// allows `https`, as browsers upgrade, and a source without a scheme takes the page's.
#[cfg(debug_assertions)]
fn source_allows(source: &str, scheme: Option<&str>, page: Option<&str>, host: &str, port: Option<&str>) -> bool {
    let upgrades =
        |ours: &str, theirs: &str| ours == theirs || (ours == "http" && theirs == "https") || (ours == "ws" && theirs == "wss");
    let scheme = scheme.or(page);
    if source.starts_with('\'') {
        return false;
    }
    if source == "*" {
        return scheme.is_none_or(|scheme| matches!(scheme, "http" | "https" | "ws" | "wss") || Some(scheme) == page);
    }
    if let Some(only) = source.strip_suffix(':').filter(|only| is_scheme(only)) {
        return scheme.is_none_or(|scheme| upgrades(only, scheme));
    }
    let (theirs, rest) = match source.split_once("://") {
        Some((theirs, rest)) => (Some(theirs), rest),
        None => (None, source),
    };
    let scheme_ok = match (theirs.or(page), scheme) {
        (Some(theirs), Some(scheme)) => upgrades(theirs, scheme),
        (None, Some(scheme)) => matches!(scheme, "http" | "https"),
        (_, None) => true,
    };
    let (source_host, source_port) = split_port(rest.split('/').next().unwrap_or(""));
    let host_ok = match source_host.strip_prefix("*.") {
        Some(domain) => {
            host.len() > domain.len() + 1 && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.'
        }
        None => source_host == "*" || source_host == host,
    };
    // A URL's port, its scheme's default when it has none (which the URL parser leaves out).
    let effective = port.or_else(|| scheme.and_then(default_port));
    let port_ok = match source_port {
        Some("*") => true,
        Some(wanted) => effective == Some(wanted) || (wanted == "80" && effective == Some("443")),
        None => port.is_none() || effective == scheme.and_then(default_port),
    };
    scheme_ok && host_ok && port_ok
}

/// Rejects a source that would break out of its directive.
fn checked(source: &str) -> String {
    assert!(
        !source.is_empty() && !source.contains([';', ',', '\r', '\n', ' ']),
        "a CSP source is one token without ';', ',' or spaces: {source:?}"
    );
    source.to_string()
}

/// Cookie helpers. Sessions belong to the app; these make the safe flags the default.
pub mod cookie {
    use http::header;
    use http::HeaderMap;
    use http::HeaderValue;

    /// The value of cookie `name` in the request, if present.
    pub fn get<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        get_in(headers.get_all(header::COOKIE).iter(), name)
    }

    pub(crate) fn get_in<'a>(values: impl Iterator<Item = &'a HeaderValue>, name: &str) -> Option<&'a str> {
        values.filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k == name).then_some(v)
        })
    }

    /// A `Set-Cookie` value: `HttpOnly; Secure; SameSite=Lax; Path=/` unless changed.
    #[derive(Clone, Debug)]
    pub struct SetCookie {
        name: String,
        value: String,
        max_age: Option<i64>,
        http_only: bool,
        secure: bool,
        same_site: &'static str,
        path: String,
    }

    /// What [`SetCookie::try_new`] refused: a name or value with a character a cookie cannot carry
    /// (a space, `;`, `,`, `"`, `\`, a control or a non-ASCII byte; `=` too in a name, and an empty
    /// name). A quoted value, which a cookie can carry, is refused too: [`get`] would hand the
    /// quotes back with it. `Name` is the app's own mistake, since names are its literals.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum InvalidCookie {
        Name,
        Value,
    }

    impl std::fmt::Display for InvalidCookie {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(match self {
                InvalidCookie::Name => "a cookie name with a character a cookie cannot carry",
                InvalidCookie::Value => "a cookie value with a character a cookie cannot carry",
            })
        }
    }

    impl std::error::Error for InvalidCookie {}

    impl SetCookie {
        /// Panics if the name or value contains characters a cookie cannot carry; a session token
        /// should be URL-safe base64 or hex. For a value from elsewhere (a token another service
        /// answered with, text a user typed), [`SetCookie::try_new`] lets the handler answer.
        #[track_caller]
        pub fn new(name: &str, value: &str) -> Self {
            match Self::try_new(name, value) {
                Ok(cookie) => cookie,
                Err(InvalidCookie::Name) => panic!("invalid cookie name {name:?}"),
                Err(InvalidCookie::Value) => panic!("invalid cookie value"),
            }
        }

        /// The cookie, or which part it cannot carry. `?` on it in a handler is a 500; to answer
        /// a value from another service otherwise, map that case:
        ///
        /// ```
        /// use corten::{http::StatusCode, security::cookie::{InvalidCookie, SetCookie}, Error};
        ///
        /// fn session(token: &str) -> Result<SetCookie, Error> {
        ///     SetCookie::try_new("session", token).map_err(|e| match e {
        ///         // The token the identity service answered with: its fault, a 502.
        ///         InvalidCookie::Value => Error::new(e).with_status(StatusCode::BAD_GATEWAY),
        ///         // The name is this app's literal: its own bug, a 500.
        ///         InvalidCookie::Name => Error::new(e),
        ///     })
        /// }
        /// # use corten::http::IntoResponse;
        /// assert!(session("c2Vzc2lvbg").is_ok());
        /// assert_eq!(session("a; b").unwrap_err().into_response().status(), StatusCode::BAD_GATEWAY);
        /// ```
        pub fn try_new(name: &str, value: &str) -> Result<Self, InvalidCookie> {
            let octet = |b: u8| b.is_ascii_graphic() && !matches!(b, b';' | b',' | b'"' | b'\\');
            if name.is_empty() || !name.bytes().all(|b| octet(b) && b != b'=') {
                return Err(InvalidCookie::Name);
            }
            if !value.bytes().all(octet) {
                return Err(InvalidCookie::Value);
            }
            Ok(SetCookie {
                name: name.into(),
                value: value.into(),
                max_age: None,
                http_only: true,
                secure: true,
                same_site: "Lax",
                path: "/".into(),
            })
        }

        /// Expires the cookie in the browser (sign-out).
        #[track_caller]
        pub fn remove(name: &str) -> Self {
            Self::new(name, "").max_age(0)
        }

        pub fn max_age(mut self, seconds: i64) -> Self {
            self.max_age = Some(seconds);
            self
        }

        /// For local development over plain HTTP only.
        pub fn insecure(mut self) -> Self {
            self.secure = false;
            self
        }

        /// Readable from script. Never for a session.
        pub fn script_readable(mut self) -> Self {
            self.http_only = false;
            self
        }

        pub fn strict(mut self) -> Self {
            self.same_site = "Strict";
            self
        }

        /// Panics on a path that does not start with `/`, or has a `;` or a control character.
        #[track_caller]
        pub fn path(mut self, path: &str) -> Self {
            assert!(path.starts_with('/') && !path.bytes().any(|b| b == b';' || b.is_ascii_control()), "invalid cookie path");
            self.path = path.into();
            self
        }

        pub fn header(&self) -> HeaderValue {
            let mut out = format!("{}={}; Path={}; SameSite={}", self.name, self.value, self.path, self.same_site);
            if let Some(age) = self.max_age {
                out.push_str(&format!("; Max-Age={age}"));
            }
            if self.http_only {
                out.push_str("; HttpOnly");
            }
            if self.secure {
                out.push_str("; Secure");
            }
            HeaderValue::try_from(out).expect("checked in try_new and path")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reporting_endpoints_member_is_found_by_its_key_outside_quotes() {
        assert!(names(br#"default="/r", csp="/c""#, b"csp"));
        assert!(names(br#"csp="/c""#, b"csp"));
        assert!(!names(br#"default="/r?a=1,csp=/x""#, b"csp"), "a comma inside a URL");
        assert!(!names(br#"default="/r\",csp=x""#, b"csp"), "an escaped quote");
        assert!(names(br#"default="/r\"", csp="/c""#, b"csp"), "after an escaped quote");
        assert!(!names(br#"cspx="/c""#, b"csp"));
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn the_app_answers_to_localhost_ip_addresses_and_its_own_names() {
        let names = ["shop.example".to_string(), ".corp.example".to_string()];
        for host in [
            "localhost",
            "localhost:3000",
            "localhost:",
            "LocalHost.",
            "app.localhost:8080",
            "127.0.0.1",
            "127.0.0.1:3917",
            "10.0.0.7:8080",
            "[::1]:3000",
            "[::1]",
            "[::ffff:10.0.0.7]:",
            "[2001:DB8::7]:443",
            "shop.example",
            "Shop.Example:443",
            "corp.example",
            "admin.corp.example",
        ] {
            assert_eq!(named(host.as_bytes(), Some(&names)), Asked::Here, "{host}");
            assert_eq!(named(host.as_bytes(), None), Asked::Here, "{host}, in an app that answers to any host");
        }
        // Hosts as HTTP writes them that are not the app's: a `reg-name` may hold more than a
        // DNS name does (RFC 3986 3.2.2), a comma among it.
        for host in [
            "rebound.attacker.example:3917",
            "localhost.attacker.example",
            "evil-localhost",
            "1.2.3.4.attacker.example",
            "999.1.1.1",
            "www.shop.example",
            "shop.example.attacker.example",
            "xcorp.example",
            "my_service:8080",
            "a.example,b.example",
            "caf%C3%A9.example",
            ".",
        ] {
            assert_eq!(named(host.as_bytes(), Some(&names)), Asked::Elsewhere, "{host}");
            assert_eq!(named(host.as_bytes(), None), Asked::Here, "{host}, in an app that answers to any host");
        }
        // Not a host and maybe a port, whatever names the app has, its own inside them too.
        for host in [
            "",
            ":3000",
            "localhost:3000:1",
            "localhost:abc",
            "localhost:3000/path",
            "localhost/path",
            "user@localhost",
            "user@127.0.0.1:8080",
            "127.0.0.1:8080, other.example.com",
            "shop.example, other.example",
            "shop.example other.example",
            "shop.example?x",
            "shop.example#x",
            "http://shop.example",
            "x%zz.corp.example",
            "x%4.corp.example",
            "x y.corp.example",
            "user@app.localhost",
            "caf\u{e9}.example",
            "[::1",
            "[::1]x",
            "[::1]:80a",
            "[]",
            "[localhost]",
            "[127.0.0.1]",
            "[v1.x]",
            "[fe80::1%25eth0]",
            "::1",
        ] {
            assert_eq!(named(host.as_bytes(), Some(&names)), Asked::Malformed, "{host}");
            assert_eq!(named(host.as_bytes(), None), Asked::Malformed, "{host}, in an app that answers to any host");
        }
    }

    /// RFC 9110 7.2's `uri-host [ ":" port ]` with RFC 3986 3.2.2's host and Corten's two
    /// choices (a name of no bytes is none, and an address in brackets is IPv6 or none), read
    /// from the start a byte at a time with no table: the other way round from [`any`], which
    /// takes the port off the end and reads the name many bytes at a look.
    fn is_host(host: &[u8]) -> bool {
        fn port(rest: &[u8]) -> bool {
            match rest {
                [] => true,
                [b':', digits @ ..] => digits.iter().all(u8::is_ascii_digit),
                _ => false,
            }
        }
        if let [b'[', inside @ ..] = host {
            let Some(end) = inside.iter().position(|&b| b == b']') else { return false };
            let address = std::str::from_utf8(&inside[..end]).ok().and_then(|a| a.parse::<std::net::Ipv6Addr>().ok());
            return address.is_some() && port(&inside[end + 1..]);
        }
        let mut at = 0;
        while at < host.len() {
            at += match host[at] {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => 1,
                b'!' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b'+' | b',' | b';' | b'=' => 1,
                b'%' if host[at + 1..].len() >= 2 && host[at + 1].is_ascii_hexdigit() && host[at + 2].is_ascii_hexdigit() => 3,
                _ => break,
            };
        }
        at > 0 && port(&host[at..])
    }

    /// The reader's short cuts, the port taken off the end and the name read sixteen or four
    /// bytes at a look, give what the grammar read a byte at a time gives ([`is_host`]): for
    /// every value of up to four bytes of what a `Host` is made of and is not, and for names of
    /// each length around those looks with each byte of them changed in turn. A name the app
    /// does not hold is another host's when it is a host, and malformed when it is none.
    #[test]
    fn a_host_read_four_bytes_at_a_look_is_what_the_grammar_says() {
        let names = ["shop.example".to_string(), ".corp.example".to_string()];
        let mut read = 0;
        let mut hold = |host: &[u8]| {
            let shown = String::from_utf8_lossy(host);
            let is = is_host(host);
            assert_eq!(named(host, None), if is { Asked::Here } else { Asked::Malformed }, "{shown:?} ({host:?})");
            assert_eq!(named(host, Some(&names)) == Asked::Malformed, !is, "{shown:?} ({host:?}), in an app with names");
            read += 1;
        };
        // Every value of none to four of these bytes.
        let bytes = [b'a', b'G', b'.', b'-', b'0', b'9', b':', b'[', b']', b'%', b'@', b'/', b' ', b',', 0xC3, 0xA9, 0xFF];
        for length in 0..=4 {
            for mut number in 0..bytes.len().pow(length) {
                let mut host = Vec::new();
                for _ in 0..length {
                    host.push(bytes[number % bytes.len()]);
                    number /= bytes.len();
                }
                hold(&host);
            }
        }
        // A name of 1 to 20 bytes, of each kind a name holds as written, and its ports.
        let whole = b"a1-b2.c3_d4~e5!f6$G7";
        let ports: [&[u8]; 11] =
            [b"", b":", b":8", b":80", b":8080", b":65535", b":0123456789", b":80a", b":a", b"::80", b":80:"];
        let with = |name: &[u8], port: &[u8]| [name, port].concat();
        for length in 1..=whole.len() {
            let name = &whole[..length];
            for (port, good) in ports.iter().zip([true, true, true, true, true, true, true, false, false, false, false]) {
                let asked = if good { Asked::Here } else { Asked::Malformed };
                assert_eq!(named(&with(name, port), None), asked, "{length} bytes and {:?}", String::from_utf8_lossy(port));
                hold(&with(name, port));
                for at in 0..length {
                    // A byte no name holds, at each place in it: the first is a space.
                    for bad in *b" /@:[%\"\\^`{|}<>#?\x00\x7F\x80\xFF" {
                        let mut host = with(name, port);
                        host[at] = bad;
                        if bad == b' ' {
                            assert_eq!(named(&host, None), Asked::Malformed, "a space at {at} of {length} bytes");
                        }
                        hold(&host);
                    }
                    // A percent-encoded byte there, whole, with a hex digit of each case in
                    // each of its two places, and cut short (`%4` is whole or not by the byte
                    // that follows it, so only the grammar says which).
                    for (encoded, whole) in [
                        (&b"%4a"[..], Some(true)),
                        (b"%4A", Some(true)),
                        (b"%aF", Some(true)),
                        (b"%C3%A9", Some(true)),
                        (b"%4", None),
                        (b"%4g", Some(false)),
                        (b"%g4", Some(false)),
                    ] {
                        let host = [&name[..at], encoded, &name[at..], port].concat();
                        if let Some(whole) = whole {
                            let asked = if whole && good { Asked::Here } else { Asked::Malformed };
                            assert_eq!(named(&host, None), asked, "{:?}", String::from_utf8_lossy(&host));
                        }
                        hold(&host);
                    }
                }
            }
        }
        // A name of letters, digits, `-` and `.` alone, which is read sixteen bytes at a look,
        // of each length up to two looks and a half, with ports of a few lengths: each of the 256
        // bytes at each place in it.
        let plain = b"Shop-2.example-cdn.region-9.example.TEST";
        let ports: [&[u8]; 7] = [b"", b":", b"1", b":8080", b":1234567", b":12345678", b"a:12345"];
        for length in 1..=plain.len() {
            for port in ports {
                let host = with(&plain[..length], port);
                hold(&host);
                for at in 0..host.len() {
                    for byte in 0..=255 {
                        let mut host = host.clone();
                        host[at] = byte;
                        hold(&host);
                    }
                }
                // A percent-encoded byte at each place, whole and cut short: the table reads on
                // from the first byte no look before the one that found its `%` read.
                for at in 0..=length {
                    for encoded in [&b"%4a"[..], b"%C3%A9", b"%4", b"%4g", b"%g4"] {
                        hold(&[&plain[..at], encoded, &plain[at..length], port].concat());
                    }
                }
            }
        }
        // Each of the 256 bytes at each place in a name of up to nine.
        for length in 1..=9 {
            for at in 0..length {
                for byte in 0..=255 {
                    let mut host = whole[..length].to_vec();
                    host[at] = byte;
                    hold(&host);
                }
            }
        }
        assert!(read > 100_000, "{read} values read");
    }

    /// A long `Host` that is no name is read sixteen bytes at a look only as far as the first look
    /// that finds a byte no plain name has: `@` and 4,095 `a` is one look, where the old
    /// reader stopped at its first byte as well, and a name that is one is read to its end. The
    /// table reads on from the first byte no earlier look read, so 4,095 `a` and `_` is read once
    /// and not again by the table from its start.
    #[test]
    fn a_long_name_that_is_none_is_not_read_to_its_end() {
        let looks = |name: &[u8]| {
            let mut looks = 0;
            let plain = plain(name, |each| {
                looks += 1;
                unlike_a_name(each)
            });
            (plain, looks)
        };
        let mut name = vec![b'a'; 4096];
        assert_eq!(looks(&name), (Ok(()), 257));
        assert!(reg_name(&name));
        name[0] = b'@';
        assert_eq!(looks(&name), (Err(0), 1));
        assert!(!reg_name(&name));
        assert_eq!(any(&name), Asked::Malformed);
        // A byte a name holds as written but a plain one does not: the table reads the rest.
        name[0] = b'_';
        assert_eq!(looks(&name), (Err(0), 1));
        assert!(reg_name(&name));
        name[0] = b'a';
        name[100] = b'@';
        assert_eq!(looks(&name), (Err(96), 7));
        assert!(!reg_name(&name));
        name[100] = b'a';
        name[4095] = b'@';
        assert_eq!(looks(&name), (Err(4080), 256));
        assert!(!reg_name(&name));
        name[4095] = b'_';
        assert_eq!(looks(&name), (Err(4080), 256));
        assert!(reg_name(&name));
        assert_eq!(any(&[&name[..], b":8080"].concat()), Asked::Here);
        // Found by the last 16 alone, after two whole sixteens: the table reads from byte 32.
        let mut name = vec![b'a'; 40];
        name[39] = b'_';
        assert_eq!(looks(&name), (Err(32), 3));
        assert!(reg_name(&name));
        // A percent-encoded byte found by a look, and one whose `%` ends the look before its
        // digits: the table and the encoded bytes are read from the first byte no earlier look
        // read, 32 where the last 16 (from 24) found it and 16 where the second look did.
        for (at, encoded, whole, from) in
            [(37, &b"%4a"[..], true, 32), (37, b"%4g", false, 32), (31, b"%4a", true, 16), (31, b"%g4", false, 16)]
        {
            let mut name = vec![b'a'; 40];
            name[at..at + 3].copy_from_slice(encoded);
            assert_eq!(looks(&name).0, Err(from), "{}", String::from_utf8_lossy(&name));
            assert_eq!(reg_name(&name), whole, "{}", String::from_utf8_lossy(&name));
        }
        // 16 bytes or fewer are none of its: `reg_name` reads them in line or by the table.
        assert_eq!(looks(&[b'a'; 16]), (Err(0), 0));
        assert_eq!(looks(b""), (Err(0), 0));
        assert!(!reg_name(b""));
    }

    /// The percent-encoded bytes of a long name are read from the look that found the `%`, not
    /// from the name's start: for 4,093 `a` and `%4a`, [`encoded`] is given its last 16 bytes
    /// alone. The `unstaged-any-encoded` cost case does not by itself catch a reader given the
    /// whole name, as the merge base it is counted against reads the whole name twice; this does.
    #[test]
    fn a_long_names_encoded_bytes_are_read_from_the_look_that_found_them() {
        // Where in `name` the bytes given to the reader start and end.
        let given = |name: &[u8]| {
            let mut given = None;
            let whole = spelled_by(name, |unread| {
                let start = unread.as_ptr() as usize - name.as_ptr() as usize;
                given = Some(start..start + unread.len());
                encoded(unread)
            });
            (whole, given)
        };
        let mut name = vec![b'a'; 4093];
        name.extend_from_slice(b"%4a");
        assert_eq!(given(&name), (true, Some(4080..4096)));
        name[4095] = b'g';
        assert_eq!(given(&name), (false, Some(4080..4096)));
        // A name the table holds as written is not given to it at all.
        name[4093..].copy_from_slice(b"__a");
        assert_eq!(given(&name), (true, None));
        // A short name, which no look reads, is given whole.
        assert_eq!(given(b"a%4a"), (true, Some(0..4)));
    }

    /// What a request asks for where no connection brought it (a test's, as these are): its
    /// target's host before its `Host`'s, one valid `Host` line at most, and none at all for
    /// HTTP/1.0 and HTTP/1.1 alike. `tests::security` sends the same over a connection, where
    /// an HTTP/1.1 request with no `Host` is refused.
    #[test]
    fn a_request_is_read_for_its_target_and_its_host_lines() {
        let policy = Policy::new();
        let any = Policy::new().any_host();
        let asked = |policy: &Policy, method: &str, target: &str, hosts: &[&str]| {
            let mut req = http::Request::builder().method(method).uri(target);
            for host in hosts {
                req = req.header("host", *host);
            }
            let req = req.body(crate::http::Body::empty()).unwrap();
            let lane = policy.host_check().asked(&req);
            assert_eq!(
                policy.asked(&req, &mut Origin::new(req.headers())),
                lane,
                "{method} {target} {hosts:?}: a route outside the stages"
            );
            lane
        };
        for policy in [&policy, &any] {
            assert_eq!(asked(policy, "GET", "/", &[]), Asked::Here);
            assert_eq!(asked(policy, "GET", "/", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "/", &["localhost", "localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "/", &["localhost", "other.example"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "/", &["localhost/"]), Asked::Malformed);
            // Nothing of a target but its own host is refused: a byte outside ASCII in its path
            // or query, and `*`, go on to the routes.
            assert_eq!(asked(policy, "GET", "/caf\u{e9}", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "/?q=caf\u{e9}", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "/caf%C3%A9?q=caf%C3%A9", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "*", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "POST", "*", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "OPTIONS", "*", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "*", &["localhost", "localhost"]), Asked::Malformed);
            // The target's host is the one asked for; `Host` is only held to being one.
            assert_eq!(asked(policy, "GET", "http://localhost/", &[]), Asked::Here);
            assert_eq!(asked(policy, "GET", "http://localhost:3000/", &["other.example"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "http://[::1]:3000/", &["localhost"]), Asked::Here);
            assert_eq!(asked(policy, "GET", "http://localhost/", &["a, b"]), Asked::Malformed);
            // The target's own is held to being a host and maybe a port too: no user, no port
            // that is no number, no address in brackets that is not IPv6, a host alone included.
            assert_eq!(asked(policy, "GET", "http://user@localhost/", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "http://user:word@localhost:3000/", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "http://user@[::1]:3000/", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "http://localhost:abc/", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "http://[v1.x]/", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "http://[fe80::1%25eth0]/", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "localhost:abc", &["localhost"]), Asked::Malformed);
            assert_eq!(asked(policy, "GET", "http://localhost/", &["localhost", "localhost"]), Asked::Malformed);
        }
        assert_eq!(asked(&policy, "GET", "/", &["other.example"]), Asked::Elsewhere);
        assert_eq!(asked(&any, "GET", "/", &["other.example"]), Asked::Here);
        assert_eq!(asked(&policy, "GET", "http://other.example/", &["localhost"]), Asked::Elsewhere);
        assert_eq!(asked(&any, "GET", "http://other.example/", &["localhost"]), Asked::Here);
        assert_eq!(asked(&policy, "CONNECT", "other.example:443", &["other.example:443"]), Asked::Elsewhere);
        let old = http::Request::builder().version(http::Version::HTTP_10).uri("/").body(crate::http::Body::empty()).unwrap();
        assert_eq!(policy.host_check().asked(&old), Asked::Here);
        // As the server marks a request it read off a connection, an HTTP/1.1 request needs its
        // `Host`, wherever its line is among the others, and HTTP/1.0's still does not.
        for (version, target, lines, asks) in [
            (http::Version::HTTP_11, "/", &[][..], Asked::Malformed),
            (http::Version::HTTP_11, "/", &[("accept", "*/*")][..], Asked::Malformed),
            (http::Version::HTTP_11, "http://localhost/", &[][..], Asked::Malformed),
            (http::Version::HTTP_11, "/", &[("host", "localhost")][..], Asked::Here),
            (http::Version::HTTP_11, "/", &[("accept", "*/*"), ("host", "localhost")][..], Asked::Here),
            (http::Version::HTTP_10, "/", &[][..], Asked::Here),
            (http::Version::HTTP_10, "/", &[("accept", "*/*")][..], Asked::Here),
            (http::Version::HTTP_10, "http://localhost/", &[][..], Asked::Here),
        ] {
            let mut read = http::Request::builder().version(version).uri(target);
            for (name, value) in lines {
                read = read.header(*name, *value);
            }
            let mut read = read.body(crate::http::Body::empty()).unwrap();
            mark_unnamed(&mut read);
            assert_eq!(policy.host_check().asked(&read), asks, "{version:?} {target} {lines:?}");
            assert_eq!(any.asked(&read, &mut Origin::new(read.headers())), asks, "{version:?} {target} {lines:?}");
        }
        // A `Host` on a later line, each name with one line, is found and held to the app's
        // names as one on the first line is, by the stages and at a route outside them.
        for (lines, asks) in [
            (&[("accept", "*/*"), ("host", "other.example")][..], Asked::Elsewhere),
            (&[("accept", "*/*"), ("user-agent", "x"), ("host", "other.example"), ("cookie", "a=b")][..], Asked::Elsewhere),
            (&[("accept", "*/*"), ("host", "a, b")][..], Asked::Malformed),
            (&[("accept", "*/*"), ("host", "LOCALHOST:3000")][..], Asked::Here),
        ] {
            let mut later = http::Request::builder().uri("/");
            for (name, value) in lines {
                later = later.header(*name, *value);
            }
            let mut later = later.body(crate::http::Body::empty()).unwrap();
            mark_unnamed(&mut later);
            assert_eq!(policy.host_check().asked(&later), asks, "{lines:?}, at a route outside the stages");
            assert_eq!(policy.asked(&later, &mut Origin::new(later.headers())), asks, "{lines:?}, by the stages");
        }
        // Another name with two lines does not make `Host` one with two, and hides no second.
        let twice = |hosts: &[&str]| {
            let mut req = http::Request::builder().uri("/").header("accept", "text/html").header("accept", "*/*");
            for host in hosts {
                req = req.header("host", *host);
            }
            policy.host_check().asked(&req.header("cookie", "a=b").body(crate::http::Body::empty()).unwrap())
        };
        assert_eq!(twice(&["localhost"]), Asked::Here);
        assert_eq!(twice(&["other.example"]), Asked::Elsewhere);
        assert_eq!(twice(&["localhost", "localhost"]), Asked::Malformed);
        assert_eq!(twice(&[]), Asked::Here);
    }

    /// What the log says of a refused request: its reason, each with a line of its own, and
    /// nothing of its query or of a user in its target.
    #[test]
    fn a_refused_request_is_logged_by_its_reason_without_its_query() {
        let why = |method: &str, target: &str, hosts: &[&str], read: bool| {
            let mut req = http::Request::builder().method(method).uri(target);
            for host in hosts {
                req = req.header("host", *host);
            }
            let mut req = req.body(crate::http::Body::empty()).unwrap();
            if read {
                mark_unnamed(&mut req);
            }
            assert_eq!(Policy::new().host_check().asked(&req), Asked::Malformed, "{method} {target} {hosts:?}");
            let reason = Refused::of(&req);
            let line = reason.line(&req);
            assert!(!line.contains("secret") && !line.contains("hunter2") && !line.contains("token"), "{line}");
            (reason, line)
        };
        assert_eq!(
            why("DELETE", "/caf\u{e9}?token=secret", &["localhost", "user:hunter2@other.example"], true),
            (Refused::Lines, "corten: refused DELETE \"/caf\u{e9}\" (400): it has 2 Host lines, and HTTP allows one".to_owned())
        );
        let (reason, line) = why("GET", "/health/live?token=secret", &[], true);
        assert!(reason == Refused::Unnamed && line.contains("\"/health/live\" (400)") && line.contains("no Host line"), "{line}");
        let (reason, line) = why("GET", "/?token=secret", &["user:hunter2@shop.example/x?token=secret"], true);
        assert!(reason == Refused::Host && line.ends_with("(it names \"shop.example\")"), "{line}");
        let (reason, line) = why("GET", "/", &["shop.example, other.example"], true);
        assert!(reason == Refused::Host && line.ends_with("(it names \"shop.example, other.example\")"), "{line}");
        let (reason, line) = why("GET", "http://user:hunter2@localhost:3000/items?token=secret", &["localhost"], false);
        assert!(reason == Refused::TargetHost && line.contains("\"/items\" (400)"), "{line}");
        assert!(line.ends_with("(it names \"localhost:3000\")"), "{line}");
        // A target that names a host is still refused for its `Host` line first, as it is read.
        let (reason, _) = why("GET", "http://localhost/", &["a, b"], false);
        assert_eq!(reason, Refused::Host);
        let (reason, _) = why("GET", "http://localhost/?token=secret", &[], true);
        assert_eq!(reason, Refused::Unnamed);
        // An `@` after a `/` or a `?` may end a user or be in a path: neither part is printed.
        for host in ["shop.example/reset?to=ann@hunter2", "user:hun/ter2@shop.example", "shop.example?hunter2@x#y"] {
            let (reason, line) = why("GET", "/", &[host], true);
            assert!(reason == Refused::Host && line.ends_with("(400): its Host is not a host and maybe a port alone"), "{line}");
        }
        // A long path and a long host are given by their start, cut where a character ends.
        let long = format!("/{}\u{e9}{}?token=secret", "a".repeat(LOGGED_BYTES - 2), "b".repeat(9000));
        let host = format!("{} x", "h".repeat(9000));
        let (reason, line) = why("GET", &long, &[host.as_str()], true);
        assert_eq!(reason, Refused::Host);
        assert_eq!(
            line,
            format!(
                "corten: refused GET \"/{}\"... (9201 bytes) (400): its Host is not a host and maybe a port alone \
                 (it names \"{}\"... (9002 bytes))",
                "a".repeat(LOGGED_BYTES - 2),
                "h".repeat(LOGGED_BYTES)
            )
        );
        assert_eq!(start("/short"), "\"/short\"");
        assert_eq!(start(&"a".repeat(LOGGED_BYTES)), format!("{:?}", "a".repeat(LOGGED_BYTES)));
        // A long method too, which a request's head has room for; one that fits is as sent.
        let (reason, line) = why(&"M".repeat(9000), "/", &["a, b"], true);
        assert_eq!(reason, Refused::Host);
        assert_eq!(
            line,
            format!(
                "corten: refused \"{}\"... (9000 bytes) \"/\" (400): its Host is not a host and maybe a port alone \
                 (it names \"a, b\")",
                "M".repeat(LOGGED_BYTES)
            )
        );
        let (_, line) = why(&"M".repeat(LOGGED_BYTES), "/", &["a, b"], true);
        assert!(line.starts_with(&format!("corten: refused {} \"/\" (400): ", "M".repeat(LOGGED_BYTES))), "{line}");
        // The line for a name that is another host's (the `421`) gives a long one the same way.
        assert_eq!(
            refused_host_line(format!("{}.example:8080", "h".repeat(9000)).as_bytes()),
            format!(
                "corten: refused a request for host \"{}\"... (9013 bytes) (421): \
                 if the app is served under that name, list it with Policy::host",
                "h".repeat(LOGGED_BYTES)
            )
        );
        assert_eq!(
            refused_host_line(b"shop.example"),
            "corten: refused a request for host \"shop.example\" (421): \
             if the app is served under that name, list it with Policy::host"
        );

        // The first request refused for a reason has a line, a later one for it none, and one
        // refused for another reason still has its own.
        let logged = [const { std::sync::atomic::AtomicBool::new(false) }; Refused::COUNT];
        let refused = |target: &str, hosts: &[&str]| {
            let mut req = http::Request::builder().uri(target);
            for host in hosts {
                req = req.header("host", *host);
            }
            let mut req = req.body(crate::http::Body::empty()).unwrap();
            mark_unnamed(&mut req);
            Refused::first(&req, &logged)
        };
        assert!(refused("/", &[]).is_some_and(|line| line.contains("no Host line")));
        assert_eq!(refused("/again", &[]), None);
        assert!(refused("/", &["a, b"]).is_some_and(|line| line.contains("its Host is not a host")));
        assert_eq!(refused("/", &["c, d"]), None);
        assert!(refused("/", &["a", "b"]).is_some_and(|line| line.contains("2 Host lines")));
        assert_eq!(refused("*", &["a", "b", "c"]), None);
        assert!(refused("http://user@localhost/", &["localhost"]).is_some_and(|line| line.contains("request-target's host")));
        assert_eq!(refused("http://user@localhost/", &["localhost"]), None);
    }

    #[test]
    #[should_panic(expected = "Policy::host takes a name")]
    fn a_host_with_a_port_is_a_startup_panic() {
        let _ = Policy::new().host("shop.example:443");
    }

    #[test]
    fn a_style_block_s_hash_joins_style_src_with_or_without_a_nonce() {
        let csp = Csp::new(&Policy::new().style_src("https://fonts.example"), "{}");
        let plain = csp.with_style(None, "'sha256-X'").unwrap();
        let plain = plain.to_str().unwrap();
        assert!(plain.contains("; style-src 'self' 'sha256-X' https://fonts.example; img-src"), "{plain}");
        assert_eq!(plain.replace(" 'sha256-X'", ""), csp.without_nonce.to_str().unwrap());
        let nonced = csp.with_style(Some("n0"), "'sha256-X'").unwrap();
        let nonced = nonced.to_str().unwrap();
        assert!(nonced.contains("; style-src 'self' 'sha256-X' 'nonce-n0' https://fonts.example; img-src"), "{nonced}");
        assert_eq!(nonced.replace(" 'sha256-X'", ""), csp.parts.join("n0"));
    }

    #[test]
    fn hash_sources_match_the_browsers_sha256() {
        // Known answers (FIPS 180-4 examples, and Node's crypto for the rest), across block sizes.
        assert_eq!(hash_source(""), "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
        assert_eq!(hash_source("abc"), "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='");
        assert_eq!(
            hash_source("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "'sha256-JI1qYdIGOLjlwCaTDD5gOaM85Flk/yFn9uzt1BnbBsE='"
        );
        assert_eq!(hash_source(&"a".repeat(1000)), "'sha256-Qe3s5C1j6Nm/UVqbppMuHCDLyfWl0TRkWttdsblzfqM='");
        // Where the length no longer fits in the last block, and a whole block.
        assert_eq!(hash_source(&"a".repeat(55)), "'sha256-n0OQ+NMMLdkuyfCVtl4rmumwqSWlJY4kHJ8ekQ9zQxg='");
        assert_eq!(hash_source(&"a".repeat(56)), "'sha256-s1Q5pKxvCUi21vnjxq8PX1kM4g8b3nCQ73lwaG7Gc4o='");
        assert_eq!(hash_source(&"a".repeat(64)), "'sha256-/+BU/nrgy23GXDr5th1SCfQ5hR20PQulmXM33xVGaOs='");
        assert_eq!(hash_source("x-a,x-b{display:contents}"), "'sha256-00iQbWJAoniMipHb+WLUVm3oMINcwW9byUcwNquEbzc='");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"a"), "YQ==");
    }

    #[test]
    fn the_target_supplies_its_authority_without_reading_the_host_line() {
        let uri = http::Uri::from_static("https://shop.example:8443/items");
        let host = request_host(&uri, || panic!("absolute-form needs no header lookup"));
        assert_eq!(host.and_then(RequestHost::text), Some("shop.example:8443"));
    }

    #[test]
    fn admission_and_request_host_agree_for_target_line_and_neither() {
        for (uri, field, wanted) in [
            ("http://listed.example/", Some("other.example"), Some("listed.example")),
            ("http://listed.example:bad/", Some("other.example"), Some("listed.example:bad")),
            ("/", Some("other.example"), Some("other.example")),
            ("/", None, None),
        ] {
            let mut builder = http::Request::builder().uri(uri);
            if let Some(host) = field {
                builder = builder.header(header::HOST, host);
            }
            let mut req = builder.body(crate::http::Body::empty()).unwrap();
            mark_unnamed(&mut req);
            let host = request_host(req.uri(), || req.headers().get(header::HOST)).and_then(RequestHost::text);
            assert_eq!(host, wanted);
            let names = [String::from("listed.example")];
            for hosts in [Some(&names[..]), None] {
                let expected = host.map_or(Asked::Malformed, |name| named(name.as_bytes(), hosts));
                assert_eq!(read(&req, || host_lines(req.headers()), hosts), expected, "{uri} {field:?} {hosts:?}");
            }
        }
    }

    #[test]
    fn the_origin_check_reads_only_the_headers_needed_to_decide() {
        let allowed = ["https://admin.example".to_string()];
        let request = headers(&[("origin", "https://admin.example"), ("sec-fetch-site", "cross-site"), ("host", "localhost")]);
        let mut origin = Origin::new(&request);
        assert!(origin.permits(&allowed, false, &http::Uri::default()));
        assert!(origin.site.is_none() && origin.host.is_none());
        assert!(!origin.permits(&[], false, &http::Uri::default()));
        assert!(origin.site.is_some() && origin.host.is_none());

        let request = headers(&[("origin", "http://localhost"), ("host", "localhost")]);
        let mut origin = Origin::new(&request);
        assert!(origin.permits(&[], false, &http::Uri::default()));
        assert_eq!(origin.site, Some(None), "an absent header is cached too");
        assert!(origin.host.is_some());
    }

    #[test]
    fn writes_from_other_sites_are_refused_and_non_browsers_pass() {
        let p = Policy::new().allow_origin("https://admin.example.com/");
        let post = Method::POST;
        let uri = http::Uri::default();
        assert!(p.same_origin(&Method::GET, &uri, &headers(&[("sec-fetch-site", "cross-site")])), "reads are not checked");
        assert!(p.same_origin(
            &post,
            &uri,
            &headers(&[("sec-fetch-site", "same-origin"), ("origin", "https://a.com"), ("host", "a.com")])
        ));
        assert!(
            p.same_origin(
                &post,
                &uri,
                &headers(&[("sec-fetch-site", "same-origin"), ("origin", "https://a.com"), ("host", "app:8080")])
            ),
            "a proxy that rewrites Host does not break same-origin writes"
        );
        assert!(!p.same_origin(
            &post,
            &uri,
            &headers(&[("sec-fetch-site", "cross-site"), ("origin", "https://evil.com"), ("host", "a.com")])
        ));
        assert!(!p.same_origin(
            &post,
            &uri,
            &headers(&[("sec-fetch-site", "same-site"), ("origin", "https://sub.a.com"), ("host", "a.com")])
        ));
        assert!(
            !p.same_origin(&post, &uri, &headers(&[("origin", "https://evil.com"), ("host", "a.com")])),
            "older browsers: Origin only"
        );
        assert!(!p.same_origin(&post, &uri, &headers(&[("origin", "null"), ("host", "a.com")])), "sandboxed frames send null");
        assert!(p.same_origin(&post, &uri, &headers(&[("origin", "http://localhost:8080"), ("host", "localhost:8080")])));
        assert!(p.same_origin(
            &post,
            &uri,
            &headers(&[("sec-fetch-site", "same-site"), ("origin", "https://admin.example.com"), ("host", "a.com")])
        ));
        assert!(p.same_origin(&post, &uri, &headers(&[])), "native apps and agents send neither header");
    }

    #[test]
    fn an_allowed_origin_is_kept_as_a_browser_writes_it_in_origin() {
        for (setting, serialized) in [
            ("https://admin.example.com", "https://admin.example.com"),
            ("https://admin.example.com/", "https://admin.example.com"),
            ("HTTPS://Admin.Example.COM", "https://admin.example.com"),
            ("https://admin_x.example.com", "https://admin_x.example.com"),
            ("https://admin.example.com:443", "https://admin.example.com"),
            ("http://admin.example.com:80", "http://admin.example.com"),
            ("http://admin.example.com:443", "http://admin.example.com:443"),
            ("https://admin.example.com:80", "https://admin.example.com:80"),
            ("https://a.example:8443", "https://a.example:8443"),
            ("https://a.example:08443/", "https://a.example:8443"),
            ("https://a.example.", "https://a.example."),
            ("http://localhost:3000", "http://localhost:3000"),
            ("http://192.168.1.5", "http://192.168.1.5"),
            ("http://192.168.1.5.:8080", "http://192.168.1.5:8080"),
            ("https://[::1]", "https://[::1]"),
            ("https://[::1]:443", "https://[::1]"),
            ("http://[2001:DB8:0:0:0:0:0:1]:8080", "http://[2001:db8::1]:8080"),
            ("http://[::ffff:192.168.1.5]", "http://[::ffff:c0a8:105]"),
            // An app's webview or a browser extension: no default port to leave out.
            ("capacitor://localhost", "capacitor://localhost"),
            ("Capacitor://LocalHost/", "capacitor://localhost"),
            ("tauri://localhost", "tauri://localhost"),
            ("chrome-extension://abcdefghijklmnopabcdefghijklmnop", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
            ("moz-extension://0b7d2b6e-6d2f-4b8e-9f0a-1c2d3e4f5a6b", "moz-extension://0b7d2b6e-6d2f-4b8e-9f0a-1c2d3e4f5a6b"),
            ("app+v1.x://localhost:443", "app+v1.x://localhost:443"),
            ("capacitor://localhost:080", "capacitor://localhost:80"),
            ("capacitor://[::1]:3000", "capacitor://[::1]:3000"),
        ] {
            assert_eq!(serialize_origin(setting).as_deref(), Ok(serialized), "{setting}");
        }
        for bad in [
            "",
            "*",
            "admin.example.com",
            "//admin.example.com",
            "https://",
            "https:///",
            "https://admin.example.com/app",
            "https://admin.example.com//",
            "https://*.example.com",
            "https://u@admin.example.com",
            "https://u:p@admin.example.com",
            "https://admin.example.com?x",
            "https://admin.example.com#x",
            "https://admin.example.com,https://b.example",
            "https://admin.example.com https://b.example",
            " https://admin.example.com",
            "https://admin example.com",
            "null",
            "https://admin..example.com",
            "https://.admin.example.com",
            "https://b\u{fc} cher.example",
            "https://1.2.3",
            "https://999.1.1.1",
            "https://admin.example.com:",
            "https://admin.example.com:+443",
            "https://admin.example.com:65536",
            "https://admin.example.com:44a",
            "https://[::1",
            "https://[::1]x",
            "https://[::1]:",
            "https://[fe80::1%25eth0]",
            "https://[1.2.3.4]",
            "https://::1",
            "capacitor://",
            "capacitor:///",
            "capacitor:localhost",
            "capacitor://u@localhost",
            "capacitor://localhost/app",
            "capacitor://localhost?x",
            "capacitor://localhost#x",
            "capacitor://*",
            "capacitor://localhost,tauri://localhost",
            "capacitor://local host",
            "capacitor://localhost:",
            "capacitor://app.1",
            "1app://localhost",
            "+app://localhost",
            "ca_p://localhost",
            "cap acitor://localhost",
            "://localhost",
        ] {
            assert_eq!(serialize_origin(bad), Err(NotOrigin::Form), "{bad:?}");
        }
        for unicode in ["https://b\u{fc}cher.example", "capacitor://b\u{fc}cher", "https://\u{fc}.example:8443"] {
            assert_eq!(serialize_origin(unicode), Err(NotOrigin::NonAsciiName), "{unicode:?}");
        }
        for (never, scheme) in [
            ("file:///", "file"),
            ("file:///etc/passwd", "file"),
            ("FILE://host/share", "file"),
            ("data:text/html,x", "data"),
            ("blob:https://admin.example.com/0b7d2b6e-6d2f-4b8e-9f0a-1c2d3e4f5a6b", "blob"),
            ("blob:https://admin.example.com", "blob"),
            ("javascript:alert(1)", "javascript"),
            ("about:blank", "about"),
            ("about://localhost", "about"),
            ("ws://admin.example.com", "ws"),
            ("wss://admin.example.com:443", "wss"),
            ("Ftp://admin.example.com", "ftp"),
        ] {
            assert!(
                matches!(serialize_origin(never), Err(NotOrigin::NeverSent { scheme: refused, .. }) if refused == scheme),
                "{never:?}"
            );
        }
    }

    #[test]
    #[should_panic(expected = "no browser sends a wss: origin, since no page is served from it")]
    fn an_allowed_origin_is_not_a_websocket_url() {
        let _ = Policy::new().allow_origin("wss://admin.example.com");
    }

    #[test]
    #[should_panic(
        expected = "no browser sends a file: origin, since a browser sends Origin: null from it, and file:// would name every local file"
    )]
    fn an_allowed_origin_is_not_a_file_url() {
        let _ = Policy::new().allow_origin("file:///");
    }

    #[test]
    #[should_panic(expected = "corten: Policy::allow_origin takes one origin")]
    fn an_allowed_origin_has_a_scheme() {
        let _ = Policy::new().allow_origin("admin.example.com");
    }

    #[test]
    #[should_panic(expected = "corten: Policy::allow_origin takes one origin")]
    fn an_allowed_origin_has_no_path() {
        let _ = Policy::new().allow_origin("https://admin.example.com/app");
    }

    #[test]
    #[should_panic(expected = "corten: Policy::allow_origin takes one origin")]
    fn an_allowed_origin_is_no_wildcard() {
        let _ = Policy::new().allow_origin("https://*.example.com");
    }

    #[test]
    #[should_panic(expected = "corten: Policy::allow_origin takes one origin")]
    fn an_allowed_origin_has_no_user() {
        let _ = Policy::new().allow_origin("https://u@admin.example.com");
    }

    #[test]
    #[should_panic(expected = "corten: Policy::allow_origin takes one origin")]
    fn an_allowed_origin_has_no_query() {
        let _ = Policy::new().allow_origin("https://admin.example.com?x");
    }

    #[test]
    #[should_panic(expected = "corten: Policy::allow_origin takes one origin")]
    fn an_allowed_origin_is_not_null() {
        let _ = Policy::new().allow_origin("null");
    }

    #[test]
    #[should_panic(expected = "write the name in its xn-- (punycode) form")]
    fn an_allowed_origin_names_its_host_in_ascii() {
        let _ = Policy::new().allow_origin("https://b\u{fc}cher.example");
    }

    /// An app's webview (Capacitor on iOS, Tauri) sends its own scheme in `Origin`; allowed,
    /// its writes go through with the user's cookies, and only that exact origin's.
    #[test]
    fn an_allowed_origin_may_be_an_apps_own_scheme() {
        let post = Method::POST;
        let uri = http::Uri::default();
        let from = |policy: &Policy, origin: &'static str| {
            policy.same_origin(
                &post,
                &uri,
                &headers(&[("origin", origin), ("sec-fetch-site", "cross-site"), ("host", "app.example")]),
            )
        };
        let app = Policy::new().allow_origin("capacitor://localhost");
        assert_eq!(app.allowed_origins(), ["capacitor://localhost"]);
        assert!(from(&app, "capacitor://localhost"));
        assert!(!from(&app, "tauri://localhost"));
        assert!(!from(&app, "capacitor://localhost:8080"));
        assert!(!from(&Policy::new(), "capacitor://localhost"), "not allowed, a cross-site write");
    }

    /// The setting as `Policy::allow_origin` keeps it, and the ones that do not start (which
    /// used to when the setting was any `scheme://host`, or an `http` origin with a user, a
    /// query, a name outside ASCII, an empty port or a numeric last label, or a scheme no
    /// `Origin` carries).
    #[test]
    fn an_allowed_origin_is_kept_or_refused_at_startup() {
        for (setting, kept) in [
            ("HTTPS://Admin.Example.COM:443/", "https://admin.example.com"),
            ("https://admin_x.example.com", "https://admin_x.example.com"),
            ("http://[::1]:3000", "http://[::1]:3000"),
            ("Capacitor://LocalHost", "capacitor://localhost"),
            ("tauri://localhost", "tauri://localhost"),
            ("chrome-extension://abcdefghijklmnopabcdefghijklmnop", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
            ("moz-extension://0b7d2b6e-6d2f-4b8e-9f0a-1c2d3e4f5a6b", "moz-extension://0b7d2b6e-6d2f-4b8e-9f0a-1c2d3e4f5a6b"),
            ("capacitor://localhost:443", "capacitor://localhost:443"),
        ] {
            assert_eq!(Policy::new().allow_origin(setting).allowed_origins(), [kept], "{setting}");
        }
        for bad in [
            "null",
            "https://u@admin.example.com",
            "https://admin.example.com?x",
            "https://admin.example.com:",
            "https://admin.example.1",
            "https://b\u{fc}cher.example",
            "file:///",
            "wss://admin.example.com",
            "ws://admin.example.com",
            "ftp://admin.example.com",
            "blob:https://admin.example.com",
            "about:blank",
            "capacitor://u@localhost",
            "capacitor://localhost/app",
            "capacitor://localhost?x",
            "capacitor://*",
            "capacitor://",
            "1app://localhost",
        ] {
            let started = std::panic::catch_unwind(|| Policy::new().allow_origin(bad));
            assert!(started.is_err(), "{bad:?}");
        }
    }

    /// An allowed origin written with its default port matches the `Origin` a browser sends,
    /// which never has one; another port is kept and must match.
    #[test]
    fn an_allowed_origin_with_its_default_port_lets_its_writes_through() {
        let post = Method::POST;
        let uri = http::Uri::default();
        let from = |policy: &Policy, origin: &'static str| {
            policy.same_origin(
                &post,
                &uri,
                &headers(&[("origin", origin), ("sec-fetch-site", "cross-site"), ("host", "app.example")]),
            )
        };
        let default_port = Policy::new().allow_origin("https://admin.example.com:443");
        assert!(from(&default_port, "https://admin.example.com"));
        assert!(!from(&default_port, "https://admin.example.com:8443"));
        let other_port = Policy::new().allow_origin("https://a.example:8443");
        assert!(from(&other_port, "https://a.example:8443"));
        assert!(!from(&other_port, "https://a.example"));
        let ipv6 = Policy::new().allow_origin("http://[::1]:3000");
        assert!(from(&ipv6, "http://[::1]:3000"));
    }

    /// A write with no `Sec-Fetch-Site` is checked against the requested authority: under hsts
    /// a plain-http page on the app's host is another origin (#1212), and a default port is the
    /// same whether it is written or not.
    #[test]
    fn a_write_without_sec_fetch_site_is_held_to_its_scheme_and_port() {
        let post = Method::POST;
        let uri = http::Uri::default();
        let write = |policy: &Policy, origin: &'static str, host: &'static str| {
            policy.same_origin(&post, &uri, &headers(&[("origin", origin), ("host", host)]))
        };
        let https_only = Policy::new().hsts();
        let either = Policy::new();
        assert!(!write(&https_only, "http://app.example", "app.example"), "a plain-http page on the app's host");
        assert!(write(&https_only, "https://app.example", "app.example"));
        assert!(write(&either, "http://app.example", "app.example"), "without hsts the public scheme is unknown");
        assert!(write(&either, "https://app.example", "app.example"));
        assert!(
            https_only.same_origin(&post, &uri, &headers(&[("sec-fetch-site", "same-origin"), ("origin", "http://app.example")])),
            "Sec-Fetch-Site still decides when it is sent"
        );
        assert!(
            Policy::new().hsts().allow_origin("http://legacy.example").same_origin(
                &post,
                &uri,
                &headers(&[("origin", "http://legacy.example"), ("host", "app.example")])
            ),
            "an origin the app allows is its own choice"
        );

        // Default ports: http 80, https 443.
        for policy in [&https_only, &either] {
            assert!(write(policy, "https://app.example", "app.example:443"));
            assert!(write(policy, "https://app.example:443", "app.example"));
            assert!(write(policy, "https://app.example:8443", "app.example:8443"));
            assert!(write(policy, "HTTPS://App.Example", "APP.example"), "names and schemes are not case-sensitive");
            assert!(write(policy, "https://app.example/", "app.example"));
            assert!(write(policy, "https://[::1]:3000", "[::1]:3000"));
            assert!(write(policy, "https://[::1]", "[::1]:443"));
            assert!(!write(policy, "https://app.example", "app.example:8443"), "another port");
            assert!(!write(policy, "https://app.example:8443", "app.example"));
            assert!(!write(policy, "https://app.example", "app.example:80"), "http's port is not https's");
            assert!(!write(policy, "https://other.example", "app.example"));
            assert!(!write(policy, "https://app.example.evil", "app.example"));
            assert!(!write(policy, "https://user@app.example", "app.example"), "an origin has no user");
            assert!(!write(policy, "https://app.example", "user@app.example"));
            assert!(!write(policy, "https://app.example/path", "app.example"), "an origin has no path");
            assert!(!write(policy, "https://app.example?x", "app.example"));
            assert!(!write(policy, "app.example", "app.example"), "an origin has a scheme");
            assert!(!write(policy, "https://app.example", ""));
            assert!(!write(policy, "https://", ""));
        }
        assert!(write(&either, "http://app.example", "app.example:80"));
        assert!(write(&either, "http://app.example:80", "app.example"));
        assert!(!write(&either, "http://app.example:443", "app.example"), "not http's default port");
        assert!(!write(&either, "http://app.example", "app.example:443"));
        assert!(!write(&https_only, "http://app.example:443", "app.example:443"), "the scheme, not only the port");
        assert!(!https_only.same_origin(&post, &uri, &headers(&[("origin", "https://app.example")])), "no Host to match");

        // Under hsts a plain-http page is refused unless it is on loopback, which a browser
        // counts as secure but sends no `Sec-Fetch-Site` from over plain http.
        for (origin, host) in [
            ("http://localhost:3000", "localhost:3000"),
            ("http://127.0.0.1:8080", "127.0.0.1:8080"),
            ("http://[::1]:3000", "[::1]:3000"),
            ("http://app.localhost", "app.localhost:80"),
            ("HTTP://LOCALHOST", "localhost"),
        ] {
            assert!(write(&https_only, origin, host), "{origin} on {host}");
        }
        for (origin, host) in [
            ("http://192.168.1.5", "192.168.1.5"),
            ("http://automation.lan:3001", "automation.lan:3001"),
            ("http://localhost.lan", "localhost.lan"),
            ("http://[fe80::1]", "[fe80::1]"),
        ] {
            assert!(!write(&https_only, origin, host), "{origin} on {host}");
            assert!(write(&either, origin, host), "{origin} on {host}");
        }
        assert!(!write(&https_only, "http://localhost:3000", "localhost:3001"), "loopback on another port");
        // Another scheme (an app's own) is no page on this host.
        for policy in [&https_only, &either] {
            assert!(!write(policy, "capacitor://localhost", "localhost"));
            assert!(!write(policy, "app://app.example", "app.example"));
            assert!(!write(policy, "ws://app.example", "app.example"));
        }
    }

    #[test]
    #[should_panic(expected = "a frame-ancestors source is a host, a scheme or 'self'")]
    fn frame_ancestors_takes_no_other_keyword() {
        let _ = Sources::default().frame_ancestors("'unsafe-inline'");
    }

    #[test]
    fn csp_carries_the_nonce_and_extra_sources() {
        let csp = Policy::new().script_src("https://js.stripe.com").frame_src("https://js.stripe.com").csp("abc");
        let import_map = hash_source(&crate::import_map(None, None, &[]));
        // A host to load scripts from: the script that makes the `default` policy is allowed by hash.
        let loads = hash_source(SCRIPT_LOADS);
        assert!(csp.contains(&format!("script-src 'self' {import_map} {loads} 'nonce-abc' https://js.stripe.com;")), "{csp}");
        assert!(csp.contains("style-src 'self' 'nonce-abc';"));
        let plain = Policy::new().csp_with(None, "{}");
        assert!(plain.contains(&format!("script-src 'self' {};", hash_source("{}"))) && !plain.contains("nonce"), "{plain}");
        assert!(csp.contains("frame-src https://js.stripe.com;"));
        assert!(Policy::new().csp("x").contains("frame-src 'none';"));
        assert!(Policy::new().csp("x").contains("frame-ancestors 'none';"), "no one frames a page by default");
        let framed = Policy::new().frame_ancestors("https://partner.example").frame_ancestors("'self'").csp("x");
        assert!(framed.contains("frame-ancestors https://partner.example 'self';"), "{framed}");
        assert!(!csp.contains("unsafe-inline"));
        assert!(csp.contains("form-action 'self';"), "a form goes to this origin only: {csp}");
        let checkout = Policy::new().form_action("https://pay.example").form_action("https://id.example").csp("abc");
        assert!(checkout.contains("form-action 'self' https://pay.example https://id.example;"), "{checkout}");
    }

    /// Pages require Trusted Types, and only the runtime's policy may be made unless the app names
    /// another, once however often it is named.
    #[test]
    fn pages_require_trusted_types_and_name_the_policies_allowed() {
        let csp = Policy::new().csp("abc");
        assert!(csp.ends_with("; require-trusted-types-for 'script'; trusted-types corten"), "{csp}");
        let sdk = Policy::new().trusted_types_policy("stripe").trusted_types_policy("default").trusted_types_policy("stripe");
        let csp = sdk.csp("abc");
        assert!(csp.ends_with("; trusted-types corten stripe default"), "{csp}");
        let styled = Policy::new().allow_style_attributes().csp("abc");
        assert!(styled.ends_with("; trusted-types corten; style-src-attr 'unsafe-inline'"), "{styled}");
        let named = |name: &'static str| std::panic::catch_unwind(|| Policy::new().trusted_types_policy(name)).is_ok();
        assert!(named("my-sdk#1") && named("a/b@c.d%e=f_g"));
        for name in ["", "corten", "two words", "'none'", "a;b", "*"] {
            assert!(!named(name), "{name:?} is refused");
        }
    }

    /// The header names every feature, in a list Chromium reads, and leaves out each one allowed;
    /// with every one allowed it is not sent. Only the bits of the features given are set.
    #[test]
    fn a_feature_allowed_leaves_the_permissions_policy() {
        // `ALL` is in declaration order, so a feature's bit is its place in the list.
        for (at, feature) in Feature::ALL.iter().enumerate() {
            assert_eq!(*feature as usize, at, "{feature:?}");
        }
        let all = Feature::denied(0).unwrap();
        assert_eq!(all.to_str().unwrap().matches("=()").count(), Feature::ALL.len());
        assert!(all.to_str().unwrap().starts_with("accelerometer=(), bluetooth=(), camera=(),"), "{all:?}");
        let bits = Feature::ALL.iter().fold(0u32, |bits, feature| {
            assert_eq!(bits & feature.bit(), 0, "{feature:?} has a bit of its own");
            bits | feature.bit()
        });
        assert_eq!(Feature::denied(bits), None);
        let sources = Sources::default().allow_feature(Feature::Camera).allow_feature(Feature::Camera);
        assert_eq!(sources.features, Feature::Camera.bit());
        assert!(!sources.is_empty());
        let without = Feature::denied(sources.features).unwrap();
        assert!(!without.to_str().unwrap().contains("camera") && without.to_str().unwrap().contains("microphone=()"));
        let mut app = Sources::default().allow_feature(Feature::Usb);
        app.add(&sources);
        assert_eq!(app.features, Feature::Usb.bit() | Feature::Camera.bit(), "an area adds to the app's");
    }

    /// What a debug build holds a write's redirect to: CSP's source matching, a source's path left
    /// out (as after any redirect).
    #[cfg(debug_assertions)]
    #[test]
    fn a_form_action_source_matches_as_a_browser_matches_it() {
        let targets = |sources: &[&str]| FormTargets {
            sources: sources.iter().map(|s| s.to_string()).collect(),
            own: Some(Own { scheme: Some("https".into()), at: "app.example".into() }),
            names: Vec::new(),
        };
        let cases: &[(&[&str], &str, bool)] = &[
            (&[], "/done", true),
            (&[], "https://app.example/done", true),
            (&[], "//app.example/done", true),
            (&[], "https://APP.example:443/x", true),
            (&[], "https://app.example:8443/x", false),
            (&[], "https://pay.example/", false),
            (&["https://pay.example"], "https://pay.example/checkout?a=1", true),
            (&["https://pay.example/only/this"], "https://pay.example/other", true),
            (&["https://pay.example"], "http://pay.example/", false),
            (&["http://pay.example"], "https://pay.example/", true),
            (&["pay.example"], "https://pay.example/", true),
            (&["pay.example"], "ftp://pay.example/", false),
            (&["https://pay.example"], "https://pay.example:8443/", false),
            (&["https://pay.example:8443"], "https://pay.example:8443/", true),
            (&["https://pay.example:*"], "https://pay.example:9/", true),
            (&["https://pay.example"], "https://pay.example:443/", true),
            (&["https://*.shop.example"], "https://id.shop.example/", true),
            (&["https://*.shop.example"], "https://shop.example/", false),
            (&["https://*.shop.example"], "https://evilshop.example/", false),
            (&["https:"], "https://anything.example/", true),
            (&["https:"], "http://anything.example/", false),
            (&["*"], "https://anything.example/", true),
            (&["'self'"], "https://pay.example/", false),
            (&["https://pay.example"], "mailto:a@pay.example", true),
            (&["https://pay.example"], "https://user@pay.example/", true),
            (&["http://localhost:9999"], "http://localhost:9999/account", true),
            (&["http://localhost:9999"], "http://localhost:9998/account", false),
            // The host is the address's own, not one a query or fragment holds.
            (&["https://pay.example"], "https://pay.example/go?next=https://other.example/", true),
            (&[], "https://evil.example/?next=https://app.example/", false),
            (&[], "https://evil.example#https://app.example/", false),
            // The page is https: 'self' over http is another origin, and so is a source with no
            // scheme over http.
            (&[], "http://app.example/done", false),
            (&["pay.example"], "http://pay.example/", false),
            (&["http://pay.example"], "https://pay.example:443/", true),
            (&["http://pay.example:80"], "https://pay.example/", true),
            (&["*"], "ftp://anything.example/", false),
            // A backslash is a slash in an http address.
            (&[], "/\\evil.example/", false),
            (&[], "https:\\\\evil.example/", false),
            (&["https://pay.example"], "https://pay.example\\x", true),
            // Without slashes, a scheme other than the page's names a host; the page's, a path.
            (&[], "http:evil.example/x", false),
            (&[], "https:done", true),
            (&[], "https:/evil.example/x", true),
            (&[], "https:\\evil.example/x", true),
            (&[], "http:/evil.example/x", false),
            // A browser strips the spaces around an address.
            (&[], " https://evil.example/", false),
        ];
        for (sources, to, allowed) in cases {
            assert_eq!(targets(sources).allows(to.as_bytes()), *allowed, "{sources:?} {to}");
        }
    }

    #[test]
    #[should_panic(expected = "a CSP source is one token")]
    fn sources_cannot_inject_directives() {
        let _ = Policy::new().script_src("https://a.com; script-src *");
    }

    #[test]
    fn nonces_are_unique_hex() {
        // More than one pool's worth, so a refill is crossed.
        let nonces: std::collections::HashSet<String> = (0..200).map(|_| Nonce::generate().0.to_string()).collect();
        assert_eq!(nonces.len(), 200);
        assert!(nonces.iter().all(|n| n.len() == 32 && n.bytes().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn cookies_default_to_safe_flags_and_parse() {
        let set = cookie::SetCookie::new("__Host-session", "abc123").max_age(3600).header();
        assert_eq!(set, "__Host-session=abc123; Path=/; SameSite=Lax; Max-Age=3600; HttpOnly; Secure");
        assert_eq!(cookie::SetCookie::remove("s").header(), "s=; Path=/; SameSite=Lax; Max-Age=0; HttpOnly; Secure");
        let h = headers(&[("cookie", "a=1; __Host-session=abc123; b=2")]);
        assert_eq!(cookie::get(&h, "__Host-session"), Some("abc123"));
        assert_eq!(cookie::get(&h, "c"), None);
    }

    #[test]
    fn a_value_a_cookie_cannot_carry_is_an_error_to_answer() {
        use cookie::{InvalidCookie, SetCookie};
        for value in ["Ada; Lovelace", "a b", "a,b", "\"q\"", "back\\slash", "caf\u{e9}", "tab\t", "nl\n", "nul\0", "del\x7f"] {
            assert_eq!(SetCookie::try_new("viewer", value).unwrap_err(), InvalidCookie::Value, "{value:?}");
        }
        for name in ["", "a=b", "a b", "a;b", "a,b", "a\"b", "a\\b", "caf\u{e9}", "a\0", "a\x7f"] {
            assert_eq!(SetCookie::try_new(name, "v").unwrap_err(), InvalidCookie::Name, "{name:?}");
        }
        let ok = SetCookie::try_new("session", "c2Vz-c2lv_bg==").unwrap();
        assert_eq!(ok.header(), "session=c2Vz-c2lv_bg==; Path=/; SameSite=Lax; HttpOnly; Secure");
        assert_eq!(
            SetCookie::try_new("s", "").unwrap().header(),
            "s=; Path=/; SameSite=Lax; HttpOnly; Secure",
            "an empty value is a cookie"
        );
    }

    #[test]
    #[should_panic(expected = "invalid cookie value")]
    fn new_still_panics_on_a_literal_it_cannot_carry() {
        let _ = cookie::SetCookie::new("viewer", "Ada; Lovelace");
    }

    #[test]
    #[should_panic(expected = "invalid cookie name \"a b\"")]
    fn new_still_panics_on_a_name_it_cannot_carry() {
        let _ = cookie::SetCookie::new("a b", "v");
    }

    #[test]
    fn a_path_with_a_control_character_panics_where_it_is_set_not_when_sent() {
        for path in ["/a\nb", "/a\rb", "/a\tb", "/a\x01", "/a\x7f", "/a;b", "a"] {
            let set = std::panic::catch_unwind(|| cookie::SetCookie::new("s", "v").path(path));
            assert!(set.is_err(), "{path:?}");
        }
        assert_eq!(
            cookie::SetCookie::new("s", "v").path("/account").header(),
            "s=v; Path=/account; SameSite=Lax; HttpOnly; Secure"
        );
        // A non-ASCII path is not a control character: it is set and sent as its UTF-8 bytes.
        assert_eq!(
            cookie::SetCookie::new("s", "v").path("/caf\u{e9}").header().as_bytes(),
            "s=v; Path=/caf\u{e9}; SameSite=Lax; HttpOnly; Secure".as_bytes()
        );
    }

    #[test]
    fn try_new_with_question_mark_is_a_500() {
        fn sign_in() -> crate::Result<cookie::SetCookie> {
            Ok(cookie::SetCookie::try_new("session", "a b")?)
        }
        assert_eq!(sign_in().unwrap_err().into_response().status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
