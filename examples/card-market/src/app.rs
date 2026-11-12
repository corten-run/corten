//! An item detail page with every production piece Corten offers switched on: security
//! policy (CSP nonce, cross-site write check), versioned assets, error pages, health, PWA with
//! push, head tags, an i18n catalog, robots/sitemap, compression, the home and category pages
//! cached by CDNs (`Public`), an item as JSON for other services and the price-alert
//! action as an MCP tool for agents, both mounted as JSON-only routes (`App::api`), and a
//! grading page whose captioned clip the browser seeks by byte ranges (its own area, `/grading`). Partners'
//! services set alerts with an API key sent as a bearer token (`Caller<Partner>`), and writes are limited per client
//! address by a middleware on the routes that take them, the item pages' area and the partner
//! API (`WriteLimit`, `ClientIp`; `PROXIES` behind a load balancer).
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use corten::{
    ClientIp, Error, ForAll, HtmlResponse,
    agent::{ToolError, Tools},
    answer::XRobotsTag,
    caller,
    http::{HeaderMap, HeaderValue, IntoResponse, Method, Request, Response, StatusCode, request::Parts},
    prelude::*,
    pwa::{FormFactor, Manifest, Pwa, Screenshot, Shortcut},
    security::{Policy, Violations},
    seo::{self, SitemapUrl},
};

use crate::{
    api, embeds, grading, items, mcp,
    model::{AlertInput, ItemView, set_alert},
    routes,
    source::Source,
    text::Msg,
    views::{
        self, AlertForm, AlertFormView, AlertMessage, ConditionGuide, Framed, ItemCard, ItemList, ItemPage, Layout, MoreOffers,
        Shown,
    },
};

/// The app, assembled: routes plus the error page, catalogs and PWA settings. Corten adds the rest.
pub fn app(source: Source) -> App {
    let writes = match std::env::var("WRITES_PER_MINUTE") {
        Ok(n) => n.trim().parse().ok().filter(|&n| n > 0).expect("WRITES_PER_MINUTE is a whole number above zero"),
        Err(_) => WRITES_PER_MINUTE,
    };
    let keys = |name: &str| std::env::var(name).unwrap_or_default();
    let app = app_with(source, Keys { partners: Partners::parse(&keys("API_KEYS")), agents: &keys("AGENT_TOKENS") }, writes);
    // The most connections held open at once (`MAX_CONNECTIONS`), so many idle or slow clients
    // cannot hold every socket the process may open; no limit unless set.
    match std::env::var("MAX_CONNECTIONS") {
        Ok(n) => {
            app.max_connections(n.trim().parse().ok().filter(|&n| n > 0).expect("MAX_CONNECTIONS is a whole number above zero"))
        }
        Err(_) => app,
    }
}

/// Who may call the JSON routes: partners by API key, agents by token (`AGENT_TOKENS`, comma
/// separated). Neither has a default, so a deploy that leaves them out lets no one in.
struct Keys<'a> {
    partners: Partners,
    agents: &'a str,
}

/// The category the installed app's shortcut opens: one of the demo catalog's (a test checks it
/// lists items there).
const SHORTCUT_CATEGORY: &str = "ember-reach";

/// The app with the keys and the writes a minute given, for tests.
fn app_with(source: Source, keys: Keys, writes: u32) -> App {
    let Keys { partners, agents } = keys;
    let tokens: Arc<[String]> = agents.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect();
    let limit = WriteLimit::new(Counts::new(writes, partners.clone()));
    let manifest = Manifest::new("Card Market", "Cards")
        .description("Buy and sell trading cards")
        .theme_color("#14213d")
        .background_color("#ffffff")
        .icon(views::Static::ICONS_192_PNG, "192x192")
        .icon(views::Static::ICONS_512_PNG, "512x512")
        .maskable_icon(views::Static::ICONS_512_PNG, "512x512")
        .categories(&["shopping"])
        // Screenshots of the home page, one for each form factor Chrome's install dialog shows.
        .screenshot(
            Screenshot::new(views::Static::SCREENSHOTS_WIDE_JPG, "1280x720").form_factor(FormFactor::Wide).label("Popular items"),
        )
        .screenshot(
            Screenshot::new(views::Static::SCREENSHOTS_NARROW_JPG, "540x960")
                .form_factor(FormFactor::Narrow)
                .label("Popular items"),
        )
        .shortcut(
            Shortcut::new("Ember Reach", &routes::Category { slug: SHORTCUT_CATEGORY })
                .icon(views::Static::ICONS_192_PNG, "192x192"),
        );
    // Agents in a browser on another site (AGENT_ORIGINS, comma separated) may call the tools.
    let origins = std::env::var("AGENT_ORIGINS").unwrap_or_default();
    // Partners' sites (EMBED_ORIGINS, comma separated) may frame an item's card, and no other page.
    let embedders = std::env::var("EMBED_ORIGINS").unwrap_or_default();
    let tools = tools(source.clone(), tokens).route();
    // Served over HTTPS in production (`HTTPS=1`): browsers are told to use it from then on.
    // What a page's policy blocks (a script writing markup, a fetch to another site) is reported
    // to `/csp-reports`, so it is seen here rather than only in a visitor's console.
    let policy = Policy::new().report_to(&routes::CspReports);
    let policy = if std::env::var_os("HTTPS").is_some() { policy.hsts() } else { policy };
    let ready = source.clone();
    App::new(routes::router(source.clone()))
        .area(|area| items::area(area, source.clone()).middleware(limit.clone()))
        .area(|area| grading::area(area).components(&[ConditionGuide]))
        .area(|area| {
            let embedders = embedders.split(',').map(str::trim).filter(|o| !o.is_empty());
            embeds::area(area, source.clone()).policy(|p| embedders.fold(p, |p, origin| p.frame_ancestors(origin)))
        })
        .assets(crate::views::Static)
        .api(|routes| api::api(routes, ApiState { source, partners }).middleware(limit.for_partners()))
        .api(|routes| {
            let routes = mcp::api(routes).route::<mcp::Mcp>(tools).errors(rpc_failure);
            origins.split(',').filter(|o| !o.is_empty()).fold(routes, |routes, origin| routes.allow_origin(origin))
        })
        .error_page(views::error_page, ())
        .messages::<Msg>()
        .components(views::COMPONENTS)
        .pwa(Pwa::new(manifest).import_script(views::Static::SW_PUSH_JS).network_only(mcp::Mcp::PATH))
        .policy(policy)
        // An item page waits on the item API: past 10 seconds the visitor gets the 503 page.
        .deadline(Duration::from_secs(10))
        // Not ready while the item API is unreachable, so a load balancer sends no traffic here.
        .ready(move || {
            let source = ready.clone();
            async move { source.reachable().await }
        })
}

/// What the JSON routes share: the items, and the partners that may set alerts.
#[derive(Clone, FromRef)]
pub struct ApiState {
    source: Source,
    #[from_ref(skip)]
    partners: Partners,
}

/// The services that may set alerts for their users, by API key: `API_KEYS` is
/// `name=key,name=key`, and without it no partner may. A real app keeps a hash of each key in
/// its database.
#[derive(Clone)]
pub struct Partners(Arc<HashMap<String, Arc<str>>>);

impl Partners {
    /// `name=key` pairs, comma separated; a pair without a name or a key is left out.
    fn parse(keys: &str) -> Self {
        let pairs = keys.split(',').filter_map(|pair| pair.split_once('=')).map(|(name, key)| (name.trim(), key.trim()));
        let pairs = pairs.filter(|(name, key)| !name.is_empty() && !key.is_empty());
        Partners(Arc::new(pairs.map(|(name, key)| (key.to_string(), Arc::from(name))).collect()))
    }

    /// The partner whose key the request sends.
    fn named(&self, headers: &HeaderMap) -> Option<&Arc<str>> {
        self.0.get(caller::bearer(headers)?)
    }
}

/// A service that sets alerts for its users, known by the API key it sends as a bearer token. A
/// handler that takes `Caller<Partner>` never runs without one: the request is a JSON 401 whose
/// `WWW-Authenticate` says to send one, and that the one sent is wrong (RFC 6750 3.1).
#[derive(Clone, Hash)]
pub(crate) struct Partner {
    pub name: Arc<str>,
}

/// In the API's OpenAPI document, the key it is known by and the header it is read from.
impl corten::openapi::Argument for Partner {
    fn describe(operation: &mut corten::openapi::Operation<'_>) {
        operation.bearer("The partner's API key.");
    }
}

impl Identify<ApiState> for Partner {
    async fn identify(parts: &Parts, state: &ApiState) -> Result<Self, Refused> {
        let refused = match (state.partners.named(&parts.headers), caller::bearer(&parts.headers)) {
            (Some(name), _) => return Ok(Partner { name: name.clone() }),
            (None, None) => Refused::unauthorized(Challenge::bearer("partners")),
            (None, Some(_)) => Refused::unauthorized(Challenge::bearer("partners").param("error", "invalid_token")),
        };
        Err(refused.message("Send a valid partner API key as a bearer token."))
    }
}

/// Writes one client may make a minute (`WRITES_PER_MINUTE` to change it): alerts send email,
/// so a script cannot set thousands.
const WRITES_PER_MINUTE: u32 = 20;

/// Alerts one partner may set a minute, for all its users together, from whatever addresses.
const PARTNER_WRITES_PER_MINUTE: u32 = 600;

/// Clients counted at most in a minute (a few megabytes); past it a new client waits for the
/// next minute, so memory stays bounded however many write. A flood from that many addresses
/// in one minute holds new writers off until the minute turns, and that is a botnet or under
/// two IPv6 /48s (65,536 /64s each, what one customer may be given): a site that faces one
/// limits at its edge (a CDN or load balancer) as well.
const ADDRESSES: usize = 100_000;

/// About `limit` writes a minute from one client, on the routes it is given to (the item pages'
/// area and the partner API): a form's post, or an alert with a key no partner has. A client is
/// its address (`ClientIp`: behind a load balancer, the one it forwards, with `PROXIES` set), an
/// IPv6 one by its /64, the block one host is given. On the partner API
/// (`for_partners`) a partner's alerts are counted by the partner instead, whatever address its
/// servers send from (`PARTNER_WRITES_PER_MINUTE`). Both share one count. A write past it is
/// refused with `Refused::too_many`: a 429 with `Retry-After`, the error page for a browser and
/// JSON for a partner. Reads pass straight through, so a page a CDN keeps stays public; agents
/// (`/mcp`) answer to their token and are not given it; and a request whose address cannot be
/// known (a test without one) is not counted.
#[derive(Clone)]
pub struct WriteLimit {
    counts: Arc<Counts>,
    /// Whether a partner's key counts the write as the partner's (on the partner API).
    partners: bool,
}

impl WriteLimit {
    fn new(counts: Counts) -> Self {
        WriteLimit { counts: Arc::new(counts), partners: false }
    }

    /// The same count, where a partner's write is the partner's.
    fn for_partners(&self) -> Self {
        WriteLimit { counts: self.counts.clone(), partners: true }
    }
}

/// The writes of every client this minute. The count starts again each minute, so a burst across
/// the turn of a minute can reach twice the limit.
pub struct Counts {
    limit: u32,
    partners: Partners,
    /// Clients counted at most in a minute ([`ADDRESSES`]).
    clients: usize,
    minute: Mutex<Minute>,
}

/// The writes of each client in the current minute.
struct Minute {
    started: Instant,
    writes: HashMap<Client, u32>,
}

/// Who a limit counts.
#[derive(PartialEq, Eq, Hash)]
enum Client {
    /// An IPv4 address, or an IPv6 address's /64.
    Address(IpAddr),
    Partner(Arc<str>),
}

impl Client {
    fn address(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V4(_) => Client::Address(ip),
            IpAddr::V6(v6) => Client::Address(IpAddr::V6((u128::from(v6) & !((1u128 << 64) - 1)).into())),
        }
    }
}

impl Counts {
    fn new(limit: u32, partners: Partners) -> Self {
        let minute = Mutex::new(Minute { started: Instant::now(), writes: HashMap::new() });
        Counts { limit, partners, clients: ADDRESSES, minute }
    }

    /// Counts a write from `client`: `None` when it may go ahead, else the seconds until it may.
    fn count(&self, client: Client, now: Instant) -> Option<u64> {
        let limit = if matches!(client, Client::Partner(_)) { PARTNER_WRITES_PER_MINUTE } else { self.limit };
        let mut minute = self.minute.lock().unwrap_or_else(|e| e.into_inner());
        let elapsed = now.duration_since(minute.started);
        if elapsed >= Duration::from_secs(60) {
            minute.started = now;
            minute.writes.clear();
        }
        let wait = 60 - now.duration_since(minute.started).as_secs().min(59);
        let full = minute.writes.len() >= self.clients;
        match minute.writes.get_mut(&client) {
            Some(writes) if *writes >= limit => Some(wait),
            Some(writes) => {
                *writes += 1;
                None
            }
            // Partners are the few `API_KEYS` names, so they need no room kept.
            None if full && !matches!(client, Client::Partner(_)) => Some(wait),
            None => {
                minute.writes.insert(client, 1);
                None
            }
        }
    }
}

impl Middleware for WriteLimit {
    async fn call(&self, mut req: Request, next: impl Next) -> Response {
        if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
            return next.run(req).await;
        }
        let partner = if self.partners { self.counts.partners.named(req.headers()).cloned() } else { None };
        let client = match partner {
            Some(name) => Some(Client::Partner(name)),
            None => ClientIp::of(&mut req).map(|ClientIp(ip)| Client::address(ip)),
        };
        if let Some(wait) = client.and_then(|client| self.counts.count(client, Instant::now())) {
            return Refused::too_many(Duration::from_secs(wait)).into_response();
        }
        next.run(req).await
    }
}

/// The site's address, for the absolute URLs search engines read (the sitemap, structured data).
const SITE: &str = "https://cards.example.com";

/// Logs what browsers report a page's policy blocked (as debug text, so a URL cannot forge a log
/// line) and answers 204, or 202 when the body held no violation (only reports of another type).
/// Both are successes, so a browser does not send the reports again. Anyone may post here, so
/// what it says is a hint, never trusted.
pub(crate) async fn csp_reports(Violations(found): Violations) -> StatusCode {
    // A few lines a post: one post may hold 100, and anyone can send them.
    for v in found.iter().take(4) {
        // The page without its query, which may hold a secret (a reset token).
        let page = v.document_url.split(['?', '#']).next();
        let (directive, blocked) = (&v.directive, &v.blocked_url);
        tracing::warn!(?directive, ?blocked, ?page, report_only = v.report_only, "a page's policy blocked something");
    }
    if found.is_empty() { StatusCode::ACCEPTED } else { StatusCode::NO_CONTENT }
}

/// Crawlers may read everything but the agents' endpoint.
pub(crate) async fn robots() -> Public<seo::File> {
    seo::robots(&[mcp::Mcp::PATH], Some(routes::Sitemap::PATH))
}

pub(crate) async fn sitemap() -> Public<seo::File> {
    let urls: Vec<String> =
        (1..=50).map(|n| format!("{SITE}{}", items::Item { id: &format!("item_{n}"), ..Default::default() })).collect();
    seo::sitemap(urls.iter().map(|loc| SitemapUrl { loc, lastmod: None }))
}

/// A page that is the same for every visitor: a CDN may serve it for a minute, and an older copy
/// for ten more while it fetches a fresh one. The page is made for everyone (`ForAll`), so it
/// cannot set a cookie.
fn shared(page: corten::Result<HtmlResponse<ForAll>>) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(60), page).stale_while_revalidate(Duration::from_secs(600))
}

pub(crate) async fn home(req: Req, State(source): State<Source>) -> Public<HtmlResult> {
    let t: Msg = req.t();
    let req = &req;
    shared(req.page(html! {
        <Layout req={req} title={t.home_title()} head="">
            <h1>{t.home_title()}</h1>
            <ItemList req={req} t={t} shelf={source.shelf()} />
        </Layout>
    }))
}

/// The trail a search engine shows for a page (schema.org `BreadcrumbList`), as structured data.
#[derive(ToJson)]
struct Breadcrumbs {
    #[serde(rename = "@context")]
    context: &'static str,
    #[serde(rename = "@type")]
    kind: &'static str,
    #[serde(rename = "itemListElement")]
    items: Vec<Crumb>,
}

#[derive(ToJson)]
struct Crumb {
    #[serde(rename = "@type")]
    kind: &'static str,
    position: usize,
    name: String,
    item: String,
}

impl Breadcrumbs {
    /// Each page's name and path, outermost first.
    fn new(pages: impl IntoIterator<Item = (String, String)>) -> Self {
        let items = pages
            .into_iter()
            .enumerate()
            .map(|(i, (name, path))| Crumb { kind: "ListItem", position: i + 1, name, item: format!("{SITE}{path}") })
            .collect();
        Breadcrumbs { context: "https://schema.org", kind: "BreadcrumbList", items }
    }
}

/// A category changes less often than the home page: a CDN keeps it for an hour, while a browser
/// still checks again after a minute. `s-maxage` keeps a CDN that follows RFC 9111 from serving
/// it stale, so the ten minutes of `stale-while-revalidate` it keeps from `shared()` are the
/// browser's alone. A category nothing is in (a slug from an old link) still answers its page,
/// but asks search engines not to list it (`X-Robots-Tag: noindex`).
pub(crate) async fn category(
    req: Req,
    State(source): State<Source>,
    Params(at): Params<routes::Category<'_>>,
) -> Public<HtmlResult> {
    let (t, slug): (Msg, _) = (req.t(), at.slug);
    let items = source.in_category(&slug);
    // The category's own name, when an item is in it; else its slug, as "Category {slug}".
    let name = items.iter().flat_map(|item| &item.categories).find(|c| c.slug == slug).map(|c| c.name.clone());
    let title = name.unwrap_or_else(|| t.category_title(&slug).to_string());
    let here = routes::Category { slug: &slug }.to_string();
    let crumbs = Breadcrumbs::new([(t.home_title().to_string(), routes::Home.to_string()), (title.clone(), here)]);
    let head = JsonLd { value: &crumbs };
    let (title, items) = (title.as_str(), items.as_slice());
    let req = &req;
    let page = req.page(html! { <Layout req={req} title={title} head={head}>{views::category(req, t, title, items)}</Layout> });
    let answer = shared(page).shared(Duration::from_secs(3600));
    if items.is_empty() { answer.header::<XRobotsTag>(HeaderValue::from_static("noindex")) } else { answer }
}

/// How the market grades a card's condition: a page of its own in an area of its own, so the pages
/// and the components' stylesheet the bench apps copy stay as they were (#1133).
pub(crate) async fn grading(req: Req) -> Public<HtmlResult> {
    let t: Msg = req.t();
    let req = &req;
    shared(req.page(html! {
        <Layout req={req} title={t.grading_title()} head="">
            <h1>{t.grading_title()}</h1>
            <ConditionGuide req={req} t={t} />
            <p><a href={routes::Home}>{t.category_back()}</a></p>
        </Layout>
    }))
}

/// The item's old address, moved for good.
pub(crate) async fn old_item(req: Req, Params(old): Params<routes::OldItem<'_>>) -> HtmlResult {
    req.moved(&items::Item { id: &old.id, ..Default::default() })
}

/// The item page. "Show all" asks for it again with `?offers=all`: with JavaScript the answer is
/// the offers the page does not have, without it the page with every offer.
pub(crate) async fn show(req: Req, State(source): State<Source>, Params(at): Params<items::Item<'_>>) -> HtmlResult {
    let item = source.item(&at.id).await?.ok_or_else(Error::not_found)?;
    let all_offers = at.view.offers == Some(Shown::All);
    let page = || async { req.page(ItemPage { all_offers, ..ItemPage::new(req.t(), &item, String::new()) }.document(&req)) };
    if all_offers { req.patch_or(MoreOffers { t: req.t(), offers: &item.offers }, page).await } else { page().await }
}

/// An item's card in a page of its own, for a partner's site to frame (`EMBED_ORIGINS`). Its link
/// opens the item's page in the partner's tab: that page may not be framed.
pub(crate) async fn embed_item(req: Req, State(source): State<Source>, Params(at): Params<embeds::EmbedItem<'_>>) -> HtmlResult {
    let item = source.item(&at.id).await?.ok_or_else(Error::not_found)?;
    let (t, item): (Msg, &ItemView) = (req.t(), &item);
    let req = &req;
    req.page(
        html! { <Framed req={req} title={item.title.as_str()}><ItemCard req={req} t={t} item={item} eager={true} /></Framed> },
    )
}

/// The cached item, serialized where it is.
pub(crate) async fn item_json(State(source): State<Source>, Params(at): Params<api::ItemJson<'_>>) -> JsonResult<Arc<ItemView>> {
    item_view(&source, &at.id).await
}

/// The item `id` as JSON, or a 404.
async fn item_view(source: &Source, id: &str) -> JsonResult<Arc<ItemView>> {
    Ok(Json(source.item(id).await?.ok_or_else(Error::not_found)?))
}

/// A partner's alert for one of its users: the form's rules, as JSON. A missing item is a 404
/// (the `?` of the item's load), and a field the rules refuse a 422 with the fields (`?` on the
/// rules' `Errors`).
pub(crate) async fn alert_json(
    Caller(partner): Caller<Partner>,
    State(source): State<Source>,
    Json(input): Json<CreateAlert>,
) -> JsonResult<AlertSet> {
    let t = Msg::default();
    let item = source.item(&input.id).await?.ok_or_else(Error::not_found)?;
    let message = set_alert(t, &item, &input.email, &input.target_price)?;
    Ok(Json(AlertSet { message, partner: Some(partner.name) }))
}

pub(crate) async fn create_alert(
    req: Req,
    State(source): State<Source>,
    Params(at): Params<items::Item<'_>>,
    Form(form): Form<AlertInput>,
) -> HtmlResult {
    let (t, id) = (req.t(), at.id);
    // An alert on an item that does not exist is a 404, whatever its fields say.
    let item = source.item(&id).await?.ok_or_else(Error::not_found)?;
    let message = match set_alert(t, &item, &form.email, &form.target_price) {
        Ok(message) => message,
        Err(errors) => {
            let view =
                AlertFormView { id: &id, title: &form.title, email: &form.email, target_price: &form.target_price, errors };
            // Without JavaScript the whole page comes back, with the form showing the errors.
            let page = || async {
                let page = ItemPage { form: view.clone(), ..ItemPage::new(t, &item, String::new()) };
                req.page(page.document(&req))
            };
            return req.invalid(&view.errors, AlertForm { t, form: view.clone() }, page).await;
        }
    };
    // Without JavaScript the browser posted a plain form: answer with the whole page.
    let page = || async { req.page(ItemPage::new(t, &item, message.clone()).document(&req)) };
    req.patch_or(AlertMessage { message: &message }, page).await
}

/// Which item, for `items.get`.
#[derive(FromJson)]
struct ItemId {
    /// Item id, like item_17.
    id: String,
}

/// A price alert as an agent or a partner asks for it: the form's fields (same names, same
/// rules) plus the item.
#[derive(FromJson)]
pub(crate) struct CreateAlert {
    /// Item id, like item_17.
    id: String,
    /// The email address to send the alert to.
    email: String,
    /// Decimal dollars, like 4.50.
    target_price: String,
}

#[derive(ToJson)]
pub(crate) struct AlertSet {
    message: String,
    /// The partner the alert was set for, when a partner set it; agents do not have one.
    #[serde(skip_serializing_if = "Option::is_none")]
    partner: Option<Arc<str>>,
}

/// A failure Corten writes itself on `/mcp` (a wrong method, a cross-site post, the deadline),
/// as the JSON-RPC error an MCP client reads, the shape the tools' own errors have (their 401
/// passes through as the tools wrote it). Which request failed is not known there, so its id is
/// `null`.
#[derive(ToJson)]
struct RpcFailure {
    jsonrpc: &'static str,
    id: (),
    error: RpcError,
}

#[derive(ToJson)]
struct RpcError {
    code: i32,
    message: String,
}

fn rpc_failure(status: StatusCode, message: &str) -> RpcFailure {
    // JSON-RPC's own codes: a request the server does not take, or the server's failure.
    let code = if status.is_server_error() { -32603 } else { -32600 };
    RpcFailure { jsonrpc: "2.0", id: (), error: RpcError { code, message: message.to_string() } }
}

/// The same read and write the page offers, as MCP tools. Agents authenticate with a bearer
/// token (`AGENT_TOKENS`, comma separated), never with the browser's cookies. Input and output
/// schemas come from the structs above.
fn tools(source: Source, tokens: Arc<[String]>) -> Tools {
    let read_source = source.clone();
    Tools::new("card-market-item-page", env!("CARGO_PKG_VERSION"))
        .auth(move |headers| match caller::bearer(headers) {
            Some(token) if tokens.iter().any(|known| known == token) => Ok(()),
            _ => Err(ToolError::Unauthorized),
        })
        .read_tool(
            "items.get",
            "Item detail: title, market summary, listings sorted by price, and buy offers.",
            move |(), input: ItemId| {
                let source = read_source.clone();
                async move {
                    let item = source.item(&input.id).await.map_err(ToolError::internal)?;
                    // The cached item, written where it is: no copy.
                    item.ok_or_else(|| ToolError::Invalid(format!("no item {}", input.id)))
                }
            },
        )
        .tool(
            "alerts.create",
            "Email the user when the item's lowest price drops below a target.",
            move |(), input: CreateAlert| {
                let source = source.clone();
                async move {
                    let t = Msg::default();
                    let item = source.item(&input.id).await.map_err(ToolError::internal)?;
                    // A tool has no 404: an id that names no item is an argument the agent corrects.
                    let item = item.ok_or_else(|| ToolError::Invalid(format!("no item {}", input.id)))?;
                    Ok(AlertSet { message: set_alert(t, &item, &input.email, &input.target_price)?, partner: None })
                }
            },
        )
}

#[cfg(test)]
mod tests {
    use corten::{
        Local,
        http::{HeaderName, Method, header},
        testing::{Answer, Call, Client as App, FormBody, NoForm},
    };
    use serde_json::json;

    use super::*;
    use crate::{api, embeds, grading, items, mcp, routes, views::ItemQuery};

    /// Fetch metadata a browser sends with a form post: a post from another site is refused.
    const SEC_FETCH_SITE: HeaderName = HeaderName::from_static("sec-fetch-site");

    /// The item the tests' catalog has, with listings and offers.
    const ITEM: items::Item = items::Item { id: "item_9", view: ItemQuery { offers: None } };

    /// The installed app's shortcut opens a category with items in the demo catalog.
    #[test]
    fn the_shortcut_opens_a_category_with_items() {
        assert!(!Source::demo().in_category(SHORTCUT_CATEGORY).is_empty(), "{SHORTCUT_CATEGORY}");
    }

    fn app() -> App {
        super::app_with(fixture(), Keys { partners: Partners::parse("dev=dev-key"), agents: "dev-token" }, WRITES_PER_MINUTE)
            .test()
    }

    /// The items `app` serves.
    fn fixture() -> Source {
        let offers: Vec<_> = (1..=7)
            .map(|n| json!({ "offer_id": format!("o{n}"), "buyer_display_name": format!("Buyer {n}"), "product_summary": "NM", "quantity_requested": 1, "price_amount": "1.00", "price_currency_code": "USD" }))
            .collect();
        let item = json!({
            "catalog_item_id": "item_9",
            "title": "Pika <Promo> & \"Friends\"",
            "description": "A card",
            "market_summary": { "lowest_price_amount": "0.50", "lowest_price_currency_code": "USD", "active_listing_count": 2, "total_visible_quantity": 3 },
            "market_listings": [
                { "listing_id": "l2", "seller_display_name": "B", "price_amount": "2.00", "price_currency_code": "USD", "visible_quantity": 1 },
                { "listing_id": "l1", "seller_display_name": "A", "seller_average_rating": "4.9", "seller_review_count": 12, "price_amount": "0.50", "price_currency_code": "USD", "visible_quantity": 2 }
            ],
            "offer_demand_matches": offers
        });
        let bare = json!({ "catalog_item_id": "item_10", "title": "Bare", "market_summary": null });
        Source::fixture(&json!({ "item_9": item, "item_10": bare }).to_string()).unwrap()
    }

    /// The alert form on `item`, posted from the page: the title, the address and the price.
    fn alert<'c>(app: &'c App, item: &items::Item, title: &str, price: &str) -> Call<'c, FormBody> {
        let f = AlertInput::FIELDS;
        app.post(item)
            .header(SEC_FETCH_SITE, "same-origin")
            .field(f.title, title)
            .field(f.email, "a@b.c")
            .field(f.target_price, price)
    }

    /// The status, the headers and the body.
    fn read(res: &Answer) -> (StatusCode, &corten::http::HeaderMap, &str) {
        (res.status(), res.headers(), res.text())
    }

    #[tokio::test]
    async fn item_page_renders_sorted_listings_five_offers_and_escaped_text() {
        let res = app().get(&ITEM).await;
        let (status, headers, html) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(headers.contains_key("content-security-policy"));
        assert!(html.find("A · 4.9 ★ (12)").unwrap() < html.find(">B<").unwrap(), "cheapest listing first");
        assert_eq!(html.matches("Buyer ").count(), 5, "the first response carries five offers");
        assert!(!html.contains("<template"), "and none kept back for a script");
        assert!(
            html.contains(r#"<form id="show-all" method="get" action="/items/item_9" data-patch><button name="offers" value="all">Show all 7 offers</button></form>"#),
            "{html}"
        );
        assert!(html.contains("<h1>Pika &lt;Promo&gt; &amp; &quot;Friends&quot;</h1>"));
        assert!(html.contains(r#"<link rel="canonical" href="/items/item_9" data-corten-head>"#));
        assert!(html.contains(r#"/scripts/listing_sort.js">"#), "the scripts the page's handlers use are preloaded");
        assert!(html.contains(r#"<link rel="manifest" href="/manifest.webmanifest">"#));
    }

    /// An item's card in a page of its own, for a partner to frame: its links open in the partner's
    /// tab, so a hover in the frame prefetches none of them, and no site may frame it unless
    /// `EMBED_ORIGINS` names it (#1129).
    #[tokio::test]
    async fn an_items_card_for_a_partners_frame_opens_its_links_in_the_partners_tab() {
        let res = app().get(&embeds::EmbedItem { id: "item_9" }).await;
        let (status, headers, html) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(html.contains(r#"<base target="_top">"#) && html.contains("<main data-no-prefetch>"), "{html}");
        assert_eq!(headers["x-frame-options"], "DENY");
    }

    #[tokio::test]
    async fn show_all_is_the_page_with_every_offer_or_with_javascript_only_the_rest() {
        let app = app();
        let all = items::Item { id: "item_9", view: ItemQuery { offers: Some(Shown::All) } };
        let res = app.get(&all).await;
        let (status, _, html) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(html.matches("Buyer ").count(), 7, "without JavaScript, the page with every offer");
        assert!(!html.contains("Show all"), "and no form");
        let res = app.get(&all).mode(Mode::Action).await;
        let (status, headers, patch) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(headers.contains_key("corten-patch"));
        assert_eq!(
            patch,
            concat!(
                r#"<template id="offer-rows" data-append>"#,
                r#"<tr><td>Buyer 6</td><td>NM</td><td>1</td><td class="price__amount">$1.00</td></tr>"#,
                r#"<tr><td>Buyer 7</td><td>NM</td><td>1</td><td class="price__amount">$1.00</td></tr>"#,
                r#"</template><template id="show-all" data-remove></template>"#,
            )
        );
    }

    #[tokio::test]
    async fn styles_are_scoped_to_components_and_served_as_one_file_after_the_app_stylesheet() {
        let app = app();
        let res = app.get(&ITEM).await;
        let html = res.text();
        assert!(html.contains(r#"<section class="item-detail__panel item-detail__summary gap-3 sm:gap-5">"#), "{html}");
        assert!(html.contains(r#"<td class="price__amount">"#));
        let link = |name: &str| html.find(&format!(r#"/{name}">"#)).unwrap_or_else(|| panic!("no {name} link"));
        assert!(link("style.css") < link("components.css"), "components come after the app's element defaults");
        let end = link("components.css") + "/components.css".len();
        let href = html[..end].rsplit_once('"').unwrap().1.to_string();
        assert!(href.starts_with("/assets/"), "{href}");
        let res = app.get(&Local::parse(&href).unwrap()).await;
        let (status, headers, css) = read(&res);
        assert_eq!((status, &headers["content-type"]), (StatusCode::OK, &"text/css; charset=utf-8".parse().unwrap()));
        let css = css.splitn(4, '\n').nth(3).expect("the three hidden rules, then the components");
        assert!(css.starts_with(":root{--color-ink:#1d1b26;"), "tokens first: {css}");
        assert!(css.contains(r#"[data-theme="dark"]{--color-ink:#ecebf2;"#) && css.contains("@media (min-width:40rem){"));
        assert!(css.contains(".sm\\:direction-row{flex-direction:row}"));
        assert!(css.contains(".item-detail__crumbs a{color:var(--color-muted);") && css.contains(".alert-form__message{"));
        assert_eq!(crate::theme::Space::_5.var(), "var(--space-5)");
    }

    #[tokio::test]
    async fn an_item_with_no_picture_has_no_gallery_and_its_text_takes_the_width() {
        let res = app().get(&items::Item { id: "item_10", ..Default::default() }).await;
        let (status, _, html) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(html.contains(r#"<div class="item-detail__top"><div class="item-detail__intro">"#), "{html}");
        assert!(!html.contains("item-detail__gallery") && !html.contains("item-detail__art"), "no empty gallery: {html}");
        // One with art has one, beside the text (`the_demo_catalog_lists_its_cards...`).
        let res = super::app(Source::demo()).test().get(&items::Item { id: "item_1", ..Default::default() }).await;
        let item = res.text();
        assert!(item.contains(r#"<div class="item-detail__gallery"><img class="item-detail__art""#), "{item}");
    }

    #[tokio::test]
    async fn the_home_page_is_shared_by_caches_and_item_pages_are_not() {
        let app = app();
        let res = app.get(&routes::Home).await;
        assert_eq!(res.headers()["cache-control"], "public, max-age=60, stale-while-revalidate=600");
        let vary: Vec<_> = res.headers().get_all("vary").iter().map(|v| v.to_str().unwrap()).collect();
        assert!(vary.contains(&"corten, accept, accept-language") && vary.contains(&"cookie"), "{vary:?}");
        let res = app.get(&routes::Home).cookie("session", "abc").await;
        assert_eq!(res.headers()["cache-control"], "private, no-cache", "a signed-in visitor's copy is theirs");
        let res = app.get(&routes::Home).mode(Mode::Navigation).await;
        assert_eq!(
            res.headers()["cache-control"],
            "private, max-age=60, stale-while-revalidate=600",
            "only the document is shared"
        );
        assert_eq!(app.get(&ITEM).await.headers()["cache-control"], "private, no-cache");
    }

    /// The grading page's condition clip: the video in MP4, then WebM, and captions in each
    /// language, the reader's the default, every file from `static/` (a versioned URL); a category
    /// links to it, and the home page has no clip (#1133).
    #[tokio::test]
    async fn the_condition_clip_is_captioned_in_the_readers_language() {
        let app = app();
        for (language, on, off) in [("en", "en", "fr"), ("fr-CA", "fr", "en")] {
            let page = app.get(&grading::Grading).header(header::ACCEPT_LANGUAGE, language).await;
            let html = page.text();
            let track = |lang: &str| {
                let at = html.find(&format!(r#"srclang="{lang}""#)).unwrap_or_else(|| panic!("{lang} track: {html}"));
                html[at..at + html[at..].find('>').unwrap()].to_string()
            };
            assert!(track(on).ends_with(" default") && !track(off).contains("default"), "{}, {}", track(on), track(off));
            assert!(track(on).contains(r#"src="/assets/"#) && track(on).contains(&format!(r#"/grading/condition.{on}.vtt""#)));
            let source = |file: &str, kind: &str| {
                let at = html.find(&format!(r#"/grading/{file}" type="{kind}">"#));
                at.unwrap_or_else(|| panic!("{file}: {html}"))
            };
            assert!(source("condition.mp4", "video/mp4") < source("condition.webm", "video/webm"));
        }
        assert!(!app.get(&routes::Home).await.text().contains("<video"), "the home page is the bench's, unchanged");
        let category = app.get(&routes::Category { slug: "promo" }).await;
        let category = category.text();
        assert!(category.contains(&format!(r#"<a href="{}">"#, grading::Grading)), "{category}");
        let sheet = |html: &str, name: &str| html.contains(&format!("/{name}\" data-corten-style>"));
        let grading = app.get(&grading::Grading).await;
        let grading = grading.text();
        assert!(sheet(grading, "sections/grading.css"), "the clip's styles are its area's: {grading}");
        let home = app.get(&routes::Home).await;
        let home = home.text();
        assert!(!sheet(home, "sections/grading.css"), "and no other page links them");
    }

    #[tokio::test]
    async fn pages_follow_accept_language_and_links_come_from_routes() {
        let app = app();
        let res = app.get(&ITEM).header(header::ACCEPT_LANGUAGE, "fr-CA, en;q=0.5").await;
        let html = res.text();
        assert!(html.contains(r#"<html lang="fr">"#) && html.contains("Voir les 7 offres") && html.contains("<h2>Annonces</h2>"));
        assert!(html.contains(r#"<form method="post" action="/items/item_9" data-patch>"#));
        assert!(html.contains(
            r#"<div data-scope="listing-sort"><h2>Annonces</h2><button type="button" data-on="click:listing_sort.toggle(@rows,@ascending,@descending)">"#
        ));
        let res = app.get(&routes::Category { slug: "promo" }).await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("<h1>Category promo</h1>") && body.contains(r#"<a href="/">Back to popular items</a>"#));
    }

    /// The API's OpenAPI document, kept beside the code for partners and client generators, and
    /// validated by `npm run check`.
    #[tokio::test]
    async fn the_openapi_document_is_current() {
        let doc = app().get(&crate::api::ApiDoc).await;
        assert_eq!(doc.status(), StatusCode::OK);
        corten::openapi::sync(concat!(env!("CARGO_MANIFEST_DIR"), "/openapi.json"), doc.text());
    }

    /// The scripts are checked against these declarations by `npm run check`.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new().components(views::COMPONENTS).sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }

    #[tokio::test]
    async fn alert_patch_embeds_the_exact_page_markup() {
        let app = app();
        let res = alert(&app, &ITEM, "Pika", "2").mode(Mode::Action).await;
        let (_, headers, body) = read(&res);
        assert_eq!(headers["corten-patch"], "1");
        assert_eq!(
            body,
            r#"<p class="alert-form__message" id="alert-message" aria-live="polite">Alert set: we will email a@b.c when Pika &lt;Promo&gt; &amp; &quot;Friends&quot; drops below $2.00.</p>"#
        );
        let cross = alert(&app, &ITEM, "Pika", "2").header(SEC_FETCH_SITE, "cross-site").await;
        assert_eq!(cross.status(), StatusCode::FORBIDDEN);
    }

    /// A French reader types the price as French writes money, and is answered in French.
    #[tokio::test]
    async fn an_alert_reads_the_price_in_the_readers_locale() {
        let app = app();
        let post = |price| alert(&app, &ITEM, "Pika", price).mode(Mode::Action).header(header::ACCEPT_LANGUAGE, "fr");
        let res = post("2,50").await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Alerte créée : nous écrirons à a@b.c quand Pika &lt;Promo&gt; &amp; &quot;Friends&quot; passera sous 2,50\u{a0}$US."), "{body}");
        // En's decimal point is not a French price: refused, not read as 250 dollars.
        let res = post("2.50").await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body.contains("Saisissez un prix cible supérieur à zéro."), "{body}");
    }

    #[tokio::test]
    async fn an_invalid_alert_is_422_with_field_errors_on_every_surface() {
        let app = app();
        let post = |mode| alert(&app, &ITEM, "Pika", "abc").mode(mode);
        let res = post(Mode::Action).await;
        let (status, headers, body) = read(&res);
        assert_eq!((status, &headers["corten-patch"]), (StatusCode::UNPROCESSABLE_ENTITY, &"1".parse().unwrap()));
        assert!(body.starts_with(r#"<div class="alert-form__form" id="alert-form">"#), "{body}");
        assert!(body.contains(
            r#"value="abc" inputmode="decimal" required aria-invalid="true" aria-describedby="alert-form-target_price-error">"#
        ));
        assert!(
            body.contains(r#"<p class="field-error" id="alert-form-target_price-error">Enter a target price above zero.</p>"#)
        );
        assert!(body.contains(r#"value="a@b.c" required>"#), "a valid field keeps its value and no error");

        let res = post(Mode::Data).await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["fields"], json!({ "target_price": "Enter a target price above zero." }));

        let res = post(Mode::Document).await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body.contains("<html") && body.contains("Show all 7 offers") && body.contains("alert-form-target_price-error"));
    }

    /// Where the time for one item page goes. Release build, benchmark fixture:
    /// `CORTEN_FIXTURE=/path/items.json cargo test --release -p card-market -- --ignored render_cost --nocapture`
    #[tokio::test]
    #[ignore]
    async fn render_cost() {
        use std::time::Instant;

        // Measured through the router alone, as `route_loop` measures it beside bare axum.
        use corten::http::{Body, Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let path = std::env::var("CORTEN_FIXTURE").expect("CORTEN_FIXTURE");
        let source = Source::fixture(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let ids: Vec<String> = (1..=500).map(|n| format!("item_{n}")).collect();
        let router = super::app(source.clone()).router();
        let t = Msg::default();
        let rounds = 20;
        let n = (rounds * ids.len()) as f64;
        let per = |start: Instant| start.elapsed().as_secs_f64() * 1e6 / n;
        let mut items = Vec::new();
        for id in &ids {
            items.push(source.item(id).await.unwrap().unwrap());
        }
        for item in &items {
            assert_eq!(
                corten::json::to_vec(item),
                serde_json::to_vec(item).unwrap(),
                "ToJson differs from serde_json on {}",
                item.id
            );
        }
        let start = Instant::now();
        for _ in 0..rounds {
            for item in &items {
                std::hint::black_box(ItemPage::new(t, item, String::new()));
            }
        }
        let build = per(start);
        let start = Instant::now();
        let mut bytes = 0;
        for _ in 0..rounds {
            for item in &items {
                bytes += std::hint::black_box(ItemPage::new(t, item, String::new()).view().to_html()).len();
            }
        }
        let render = per(start);
        println!("build view: {build:.1} us, build + render main: {render:.1} us ({} bytes avg)", bytes / (rounds * ids.len()));
        let start = Instant::now();
        let mut bytes = 0;
        for _ in 0..rounds {
            for item in &items {
                bytes += std::hint::black_box(corten::json::to_vec(item)).len();
            }
        }
        println!("item as JSON: {:.1} us ({} bytes avg)", per(start), bytes / (rounds * ids.len()));
        // The item API's responses, read as the API source reads them: the same items as serde_json.
        let text = std::fs::read_to_string(&path).unwrap();
        let raw: std::collections::HashMap<String, &serde_json::value::RawValue> = serde_json::from_str(&text).unwrap();
        let responses: Vec<&str> = ids.iter().map(|id| raw[id].get()).collect();
        for (id, response) in ids.iter().zip(&responses) {
            let ours = ItemView::from(corten::json::from_str::<crate::model::ApiItem>(response).unwrap());
            let theirs = ItemView::from(serde_json::from_str::<crate::model::ApiItem>(response).unwrap());
            // Compared as text: a NaN price is not equal to itself.
            assert_eq!(format!("{ours:?}"), format!("{theirs:?}"), "FromJson reads {id} differently from serde_json");
        }
        let parse_rounds = 5;
        let parse = |read: &dyn Fn(&str) -> usize| {
            let start = Instant::now();
            for _ in 0..parse_rounds {
                for response in &responses {
                    std::hint::black_box(read(std::hint::black_box(response)));
                }
            }
            start.elapsed().as_secs_f64() * 1e6 / (parse_rounds * responses.len()) as f64
        };
        let serde = parse(&|r| serde_json::from_str::<crate::model::ApiItem>(r).is_ok() as usize);
        let ours = parse(&|r| corten::json::from_str::<crate::model::ApiItem>(r).is_ok() as usize);
        let size = responses.iter().map(|r| r.len()).sum::<usize>() / responses.len();
        println!("item API response read: serde_json {serde:.1} us, FromJson {ours:.1} us ({size} bytes avg)");
        for (label, prefix, mode, encoding) in [
            ("navigation, identity", "/items/", Some("nav"), "identity"),
            ("document, identity", "/items/", None, "identity"),
            ("document, zstd", "/items/", None, "gzip, deflate, br, zstd"),
            ("document, br", "/items/", None, "gzip, deflate, br"),
            ("document, gzip", "/items/", None, "gzip"),
            ("json, identity", "/api/items/", None, "identity"),
        ] {
            let start = Instant::now();
            let mut size = 0;
            for _ in 0..rounds {
                for id in &ids {
                    let mut req = Request::get(format!("{prefix}{id}")).header("accept-encoding", encoding);
                    if let Some(mode) = mode {
                        req = req.header("corten", mode);
                    }
                    let res = router.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
                    size += std::hint::black_box(res.into_body().collect().await.unwrap().to_bytes()).len();
                }
            }
            println!("full request, {label}: {:.1} us, {} bytes avg", per(start), size / (rounds * ids.len()));
        }
    }

    /// What reading the item API's responses costs, for callgrind: each of the 500 benchmark
    /// responses read once by `read_all`, with `FromJson` or (`READ_WITH=serde`) serde_json. Build
    /// with `cargo test --release -p card-market --no-run`, then run the binary it names:
    /// `CORTEN_FIXTURE=/path/items.json valgrind --tool=callgrind --collect-atstart=no
    /// --toggle-collect='*read_all*' <test binary> --ignored --exact app::tests::read_cost`; the
    /// instructions over 500 are one response's. Take both readers: `FromJson` falling back to
    /// serde_json on a response shows as its count nearing serde_json's.
    #[test]
    #[ignore]
    fn read_cost() {
        #[inline(never)]
        fn read_all(responses: &[&str], serde: bool) -> usize {
            let read = |r: &str| {
                if serde {
                    serde_json::from_str::<crate::model::ApiItem>(r).is_ok()
                } else {
                    corten::json::from_str::<crate::model::ApiItem>(r).is_ok()
                }
            };
            responses.iter().filter(|r| read(std::hint::black_box(r))).count()
        }
        let path = std::env::var("CORTEN_FIXTURE").expect("CORTEN_FIXTURE");
        let text = std::fs::read_to_string(&path).unwrap();
        let raw: std::collections::HashMap<String, &serde_json::value::RawValue> = serde_json::from_str(&text).unwrap();
        let responses: Vec<&str> = (1..=500).map(|n| raw[&format!("item_{n}")].get()).collect();
        let serde = std::env::var("READ_WITH").is_ok_and(|w| w == "serde");
        assert_eq!(read_all(&responses, serde), responses.len());
    }

    /// What an agent's `items.get` call costs, for callgrind: `TOOL_CALLS` calls through `/mcp`,
    /// one item after another from the fixture, each with the `MCP-Protocol-Version` a client sends
    /// after `initialize`, and answered with the item as written by its `ToJson`. Build with
    /// `cargo test --release -p card-market --no-run`, then run the binary
    /// twice, `CORTEN_FIXTURE=/path/items.json TOOL_CALLS=200` and `=1200`, under
    /// `valgrind --tool=callgrind <test binary> --ignored --exact app::tests::tool_cost`: the
    /// difference over 1,000 is one call, without startup and setup.
    #[tokio::test]
    #[ignore]
    async fn tool_cost() {
        use corten::http::{Body, Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let path = std::env::var("CORTEN_FIXTURE").expect("CORTEN_FIXTURE");
        let source = Source::fixture(&std::fs::read_to_string(path).unwrap()).unwrap();
        let router = super::app_with(source, Keys { partners: Partners::parse(""), agents: "t" }, WRITES_PER_MINUTE).router();
        let calls: usize = std::env::var("TOOL_CALLS").expect("TOOL_CALLS").parse().unwrap();
        let bodies: Vec<String> = (1..=500)
            .map(|n| {
                json!({ "jsonrpc": "2.0", "id": n, "method": "tools/call", "params": { "name": "items.get", "arguments": { "id": format!("item_{n}") } } })
                    .to_string()
            })
            .collect();
        let mut bytes = 0;
        for body in bodies.iter().cycle().take(calls) {
            let req = Request::post(mcp::Mcp::PATH)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .header("authorization", "Bearer t")
                .header("mcp-protocol-version", corten::agent::PROTOCOL_VERSIONS[0])
                .body(Body::from(body.clone()))
                .unwrap();
            let res = router.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::OK);
            let body = std::hint::black_box(res.into_body().collect().await.unwrap().to_bytes());
            // A tool error is a 200 too: measure the output written, not the error path. The end
            // says which, at the same cost whatever the output's size.
            assert!(body.ends_with(br#","isError":false}}"#), "{}", String::from_utf8_lossy(&body));
            bytes += body.len();
        }
        println!("{calls} calls, {} bytes avg", bytes / calls);
    }

    #[tokio::test]
    #[ignore]
    async fn route_loop() {
        use std::time::{Duration, Instant};

        // Against axum alone too (`bare-json`), so through the router, not the test client.
        use corten::http::{HeaderMap, Request, Response};
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        /// Sends `paths` through `router` over and over for `seconds`, each request as `request`
        /// makes it: how many it sent, in how long, and the headers of the first path's answer.
        /// Generic, so Corten's router and axum's are each driven with their own body types.
        async fn drive<S, B, R>(
            router: S,
            request: impl Fn(&str) -> Request<B>,
            paths: &[String],
            seconds: u64,
        ) -> (u64, Duration, HeaderMap)
        where
            S: tower::Service<Request<B>, Response = Response<R>, Error = std::convert::Infallible> + Clone,
            R: http_body::Body,
            R::Error: std::fmt::Debug,
        {
            let start = Instant::now();
            let mut count = 0u64;
            while start.elapsed() < Duration::from_secs(seconds) {
                for path in paths {
                    let res = router.clone().oneshot(request(path)).await.unwrap();
                    std::hint::black_box(res.into_body().collect().await.unwrap().to_bytes());
                }
                count += paths.len() as u64;
            }
            let took = start.elapsed();
            let res = router.oneshot(request(&paths[0])).await.unwrap();
            (count, took, res.headers().clone())
        }

        let path = std::env::var("CORTEN_FIXTURE").expect("CORTEN_FIXTURE");
        let source = Source::fixture(&std::fs::read_to_string(path).unwrap()).unwrap();
        let target = std::env::var("LOOP_TARGET").unwrap_or_else(|_| "json".into());
        let seconds: u64 = std::env::var("LOOP_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
        let (prefix, mode) = match target.as_str() {
            "json" | "bare-json" => ("/api/items/", None),
            "page" => ("/items/", Some("nav")),
            "document" => ("/items/", None),
            other => panic!("unknown LOOP_TARGET {other}"),
        };
        // What the client sends: `curl`'s `identity` by default. A browser's names its compressions
        // (`LOOP_ENCODING="gzip, deflate, br, zstd"`) and has the page's tag hashed; `LOOP_TAG`, an
        // `If-None-Match` that matches nothing, has it hashed without compressing it.
        let encoding = std::env::var("LOOP_ENCODING").unwrap_or_else(|_| "identity".into());
        let tag = std::env::var("LOOP_TAG").ok().filter(|tag| !tag.is_empty());
        let paths: Vec<String> = (1..=500).map(|n| format!("{prefix}item_{n}")).collect();
        let request = |path: &str| {
            let mut req = Request::get(path).header("accept-encoding", encoding.as_str());
            if let Some(tag) = &tag {
                req = req.header("if-none-match", tag.as_str());
            }
            if let Some(mode) = mode {
                req = req.header("corten", mode);
            }
            req
        };
        let (count, took, headers) = if target == "bare-json" {
            // Axum alone (its own dependency here, not Corten's), without Corten around the
            // handler: what Corten's layer costs. The item is read as `item_json` reads it, its
            // id by axum's own `Path`, and its JSON written as Corten's `Json` writes it, into
            // axum's body, which boxes it once, as Corten's does. A failure (none in this loop) is
            // Corten's answer.
            use axum::extract::{Path, State};
            let bare = axum::routing::get(|State(source): State<Source>, Path(id): Path<String>| async move {
                let item = match super::item_view(&source, &id).await {
                    Ok(corten::Json(item)) => item,
                    Err(e) => return corten::http::IntoResponse::into_response(e).map(axum::body::Body::new),
                };
                let mut res = Response::new(axum::body::Body::from(corten::json::to_vec(&item)));
                res.headers_mut()
                    .insert(corten::http::header::CONTENT_TYPE, corten::http::HeaderValue::from_static("application/json"));
                res
            });
            let router = axum::Router::new().route(api::ItemJson::PATH, bare).with_state(source.clone());
            drive(router, |path| request(path).body(axum::body::Body::empty()).unwrap(), &paths, seconds).await
        } else {
            let router = super::app(source.clone()).router();
            drive(router, |path| request(path).body(corten::http::Body::empty()).unwrap(), &paths, seconds).await
        };
        let per = took.as_secs_f64() * 1e6 / count as f64;
        let header = |name| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("none").to_owned();
        println!("{target} ({encoding}): tag {}, content-encoding {}", header("etag"), header("content-encoding"));
        println!("{target}: {count} requests, {per:.2} us per request");
    }

    #[tokio::test]
    async fn an_alert_on_an_item_with_no_listings_is_a_message_for_the_whole_form() {
        let app = app();
        let res = alert(&app, &items::Item { id: "item_10", ..Default::default() }, "Bare", "2").mode(Mode::Action).await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            body.contains(
                r#"<p class="form-error" role="alert">This item has no listings yet, so there is no price to watch.</p>"#
            ),
            "{body}"
        );
        assert!(!body.contains("aria-invalid"), "no field is marked: {body}");
    }

    #[tokio::test]
    async fn an_alert_on_an_item_that_does_not_exist_is_not_found() {
        let app = app();
        let res = alert(&app, &items::Item { id: "item_404", ..Default::default() }, "Gone", "2").mode(Mode::Action).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_old_item_address_moves_for_good_and_a_category_carries_its_trail() {
        let app = app();
        let res = app.get(&routes::OldItem { id: "item_9" }).await;
        assert_eq!((res.status(), res.headers()["location"].to_str().unwrap()), (StatusCode::MOVED_PERMANENTLY, &*ITEM.href()));
        let res = app.get(&routes::Category { slug: "promo" }).await;
        let (_, headers, html) = read(&res);
        let cache = headers["cache-control"].to_str().unwrap();
        assert!(cache.starts_with("public, max-age=60,") && cache.contains("s-maxage=3600"), "{cache}");
        assert_eq!(headers["x-robots-tag"], "noindex", "nothing is in this category: not for search results");
        assert!(
            html.contains(r#"<script type="application/ld+json" data-corten-head>{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Popular items","item":"https://cards.example.com/"},{"@type":"ListItem","position":2,"name":"Category promo","item":"https://cards.example.com/categories/promo"}]}</script>"#),
            "{html}"
        );
    }

    #[tokio::test]
    async fn pwa_offline_health_and_seo_routes_answer() {
        let app = app();
        let at = |path| Local::parse(path).unwrap();
        let res = app.get(&at(corten::pwa::MANIFEST_PATH)).await;
        let (_, headers, manifest) = read(&res);
        assert_eq!(headers["content-type"], "application/manifest+json");
        assert!(manifest.contains(r#""purpose":"maskable""#));
        let res = app.get(&at("/service-worker.js")).await;
        let worker = res.text();
        // A versioned static URL, /assets/{12 hex}/{file}, somewhere in the worker's lists.
        let has = |text: &str, file: &str| {
            text.split(['"', '[', ']', ',']).any(|part| {
                part.starts_with("/assets/")
                    && part.ends_with(&format!("/{file}"))
                    && part.split('/').nth(2).is_some_and(|v| v.len() == 12)
            })
        };
        assert!(worker.contains(r#"const OFFLINE = "/offline";"#) && has(worker, "style.css"), "{worker}");
        assert!(
            worker.starts_with("// Generated") && worker.contains("importScripts(...[\"/assets/") && has(worker, "sw-push.js")
        );
        let res = app.get(&at("/offline")).await;
        let (status, _, offline) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(offline.contains("<h1>Not available</h1>"), "{offline}");
        assert_eq!(app.get(&at("/health/ready")).await.status(), StatusCode::OK);
        assert!(app.get(&routes::Robots).await.text().contains("Disallow: /mcp"));
        let res = app.get(&items::Item { id: "nope", ..Default::default() }).await;
        let (status, headers, body) = read(&res);
        assert_eq!((status, &headers["x-robots-tag"]), (StatusCode::NOT_FOUND, &"noindex".parse().unwrap()));
        assert!(body.contains("<h1>Not found</h1>"), "{body}");
        assert!(body.contains(r#"<p><a href="/">Go to popular items</a></p>"#), "a way back from a missing page: {body}");
    }

    #[tokio::test]
    async fn the_demo_catalog_lists_its_cards_on_the_home_and_category_pages() {
        let app = super::app(Source::demo()).test();
        let item = |id| items::Item { id, ..Default::default() };
        let home = app.get(&routes::Home).await;
        let home = home.text();
        assert!(home.contains("<strong>Ashen Drake</strong>") && home.contains("From $42.50"), "{home}");
        assert!(home.find(r#"href="/items/item_2""#).unwrap() < home.find(r#"href="/items/item_10""#).unwrap(), "in id order");
        assert!(
            home.contains(r#"/cards/item_1.svg" width="250" height="350" alt="">"#)
                && home.contains(r#"/cards/item_6.svg" width="250" height="350" alt="" loading="lazy">"#),
            "each card shows its art, sized, and past the first row loaded near the screen: {home}"
        );
        let item_1 = app.get(&item("item_1")).await;
        let item_1 = item_1.text();
        assert!(item_1.contains(r#"/cards/item_1.svg" width="220" height="308" alt="Ashen Drake card art">"#), "{item_1}");
        let json = app.get(&api::ItemJson { id: "item_1" }).await;
        let json = json.text();
        assert!(!json.contains(r#""art""#) && !json.contains("cards/"), "the JSON is the API's, without the store's art: {json}");
        // The same responses from another source are another store's cards: no art.
        let other = super::app(Source::fixture(include_str!("../fixtures/demo.json")).unwrap()).test();
        assert!(!other.get(&item("item_1")).await.text().contains("cards/"), "art is the demo catalog's alone");
        let category = app.get(&routes::Category { slug: "tidebreak" }).await;
        assert!(!category.headers().contains_key("x-robots-tag"), "a category with cards may be listed");
        let category = category.text();
        assert!(category.contains("<h1>Tidebreak</h1>") && category.contains("Salt Oracle"), "{category}");
        assert!(!category.contains("Ashen Drake"), "only the category's cards");
        let boxed = app.get(&item("item_12")).await;
        let boxed = boxed.text();
        assert!(boxed.contains("Lantern Warden"), "a sealed box lists what it contains: {boxed}");
    }

    /// The item API has no list: the home page links the first ids, in the visitor's language.
    #[tokio::test]
    async fn against_the_item_api_the_home_page_links_the_first_ids() {
        let source = Source::Api { client: reqwest::Client::new(), base: "http://127.0.0.1:9".into() };
        let app = super::app(source).test();
        let home = app.get(&routes::Home).header(header::ACCEPT_LANGUAGE, "fr").await;
        let home = home.text();
        assert!(home.contains(r#"<a href="/items/item_5">Article 5</a>"#), "{home}");
        assert_eq!(home.matches("<li>").count(), 50);
        let category = app.get(&routes::Category { slug: "x" }).await;
        let category = category.text();
        assert!(category.contains("<h1>Category x</h1>") && !category.contains("<ul"), "{category}");
    }

    #[tokio::test]
    async fn agents_read_items_and_set_alerts_with_a_token() {
        let app = app();
        let call = |token: Option<&str>, body: serde_json::Value| {
            let call = app.call(Method::POST, &mcp::Mcp).json(&body);
            match token {
                Some(token) => call.header(header::AUTHORIZATION, &format!("Bearer {token}")),
                None => call,
            }
        };
        async fn send(call: Call<'_, NoForm>) -> (StatusCode, corten::http::HeaderMap, String) {
            let res = call.await;
            (res.status(), res.headers().clone(), res.text().to_string())
        }
        let alert = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "alerts.create", "arguments": { "id": "item_9", "email": "a@b.c", "target_price": "1" } } });
        let (_, _, body) = send(call(Some("dev-token"), alert.clone())).await;
        let res: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            res["result"]["structuredContent"]["message"],
            "Alert set: we will email a@b.c when Pika <Promo> & \"Friends\" drops below $1.00."
        );
        assert_eq!(res["result"]["structuredContent"].get("partner"), None, "an agent's alert has no partner: {body}");
        // The scheme is matched in any case (RFC 9110 11.1). The endpoint answers an empty token
        // as none: told where to get one, with no `invalid_token`.
        let lower = app.call(Method::POST, &mcp::Mcp).json(&alert).header(header::AUTHORIZATION, "bearer dev-token");
        let res: serde_json::Value = serde_json::from_str(&send(lower).await.2).unwrap();
        assert!(res["result"]["structuredContent"]["message"].is_string(), "{res}");
        for empty in ["Bearer", "Bearer  "] {
            let (status, headers, _) =
                send(app.call(Method::POST, &mcp::Mcp).json(&alert).header(header::AUTHORIZATION, empty)).await;
            assert_eq!(
                (status, &headers["www-authenticate"]),
                (StatusCode::UNAUTHORIZED, &r#"Bearer realm="card-market-item-page""#.parse().unwrap()),
                "{empty:?}"
            );
        }
        // The tools' own refusal keeps its request's id: `Api::errors` leaves a JSON body as it is.
        // A bearer token that was sent and refused is named invalid (RFC 6750).
        let (status, headers, body) = send(call(Some("wrong"), alert)).await;
        assert_eq!(
            (status, &headers["www-authenticate"]),
            (StatusCode::UNAUTHORIZED, &r#"Bearer realm="card-market-item-page", error="invalid_token""#.parse().unwrap())
        );
        let res: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!((res["id"].clone(), res["error"]["code"].clone()), (json!(1), json!(-32001)), "{body}");
        let bad = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "alerts.create", "arguments": { "id": "item_9", "email": "nope", "target_price": "1" } } });
        let res: serde_json::Value = serde_json::from_str(&send(call(Some("dev-token"), bad)).await.2).unwrap();
        assert_eq!(res["result"]["isError"], true);
        assert_eq!(res["result"]["content"][0]["text"], "invalid arguments: email: Enter a valid email address.");
        // The page's rules in the page's order: an item with no listings has no price to watch,
        // and an id that names no item is refused before its fields are read.
        let bare = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "alerts.create", "arguments": { "id": "item_10", "email": "a@b.c", "target_price": "2" } } });
        let res: serde_json::Value = serde_json::from_str(&send(call(Some("dev-token"), bare)).await.2).unwrap();
        assert_eq!(res["result"]["isError"], true, "{res}");
        assert_eq!(
            res["result"]["content"][0]["text"],
            "invalid arguments: This item has no listings yet, so there is no price to watch."
        );
        let gone = json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "alerts.create", "arguments": { "id": "nope", "email": "nope", "target_price": "1" } } });
        let res: serde_json::Value = serde_json::from_str(&send(call(Some("dev-token"), gone)).await.2).unwrap();
        assert_eq!(res["result"]["isError"], true, "{res}");
        assert_eq!(res["result"]["content"][0]["text"], "invalid arguments: no item nope");
        let list = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" });
        let res: serde_json::Value = serde_json::from_str(&send(call(None, list)).await.2).unwrap();
        let create = &res["result"]["tools"][0];
        assert_eq!(create["name"], "alerts.create");
        assert_eq!(
            create["inputSchema"],
            json!({
                "description": "A price alert as an agent or a partner asks for it: the form's fields (same names, same\nrules) plus the item.",
                "properties": {
                    "email": { "description": "The email address to send the alert to.", "type": "string" },
                    "id": { "description": "Item id, like item_17.", "type": "string" },
                    "target_price": { "description": "Decimal dollars, like 4.50.", "type": "string" },
                },
                "required": ["id", "email", "target_price"],
                "type": "object",
            }),
            "the input schema comes from FromJson's reading of the struct"
        );
        assert_eq!(
            create["outputSchema"],
            json!({
                "properties": {
                    "message": { "type": "string" },
                    "partner": { "description": "The partner the alert was set for, when a partner set it; agents do not have one.", "type": ["string", "null"] },
                },
                "required": ["message"],
                "type": "object",
            }),
            "skip_serializing_if leaves the partner out of required"
        );
        let fields: Vec<&str> =
            create["inputSchema"]["required"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(
            fields.contains(&AlertInput::FIELDS.email.as_str()) && fields.contains(&AlertInput::FIELDS.target_price.as_str()),
            "the tool takes the form's fields under the same names, so validation errors name them right: {fields:?}"
        );
        let get = &res["result"]["tools"][1];
        assert_eq!(get["name"], "items.get");
        assert_eq!(
            get["inputSchema"],
            json!({ "description": "Which item, for `items.get`.", "properties": { "id": { "description": "Item id, like item_17.", "type": "string" } }, "required": ["id"], "type": "object" })
        );
        assert_eq!(
            get["outputSchema"],
            json!({
                "$defs": {
                    "Category": {
                        "properties": {
                            "name": { "type": "string" },
                            "slug": { "type": "string" },
                        },
                        "required": ["name", "slug"],
                        "type": "object",
                    },
                    "ContentLine": {
                        "properties": {
                            "id": { "type": "string" },
                            "item_id": { "type": "string" },
                            "quantity": { "format": "int64", "type": "integer" },
                            "title": { "type": "string" },
                        },
                        "required": ["id", "item_id", "title", "quantity"],
                        "type": "object",
                    },
                    "Field": {
                        "properties": {
                            "name": { "type": "string" },
                            "value": { "type": "string" },
                        },
                        "required": ["name", "value"],
                        "type": "object",
                    },
                    "Listing": {
                        "properties": {
                            "condition": { "type": "string" },
                            "id": { "type": "string" },
                            "price": { "type": "string" },
                            "price_value": { "format": "double", "type": "number" },
                            "quantity": { "format": "int64", "type": "integer" },
                            "rating": { "type": ["string", "null"] },
                            "reviews": { "format": "int64", "type": "integer" },
                            "seller": { "type": "string" },
                            "ships_from": { "type": "string" },
                        },
                        "required": ["id", "seller", "rating", "reviews", "condition", "ships_from", "quantity", "price", "price_value"],
                        "type": "object",
                    },
                    "Offer": {
                        "properties": {
                            "buyer": { "type": "string" },
                            "condition": { "type": "string" },
                            "id": { "type": "string" },
                            "price": { "type": "string" },
                            "quantity": { "format": "int64", "type": "integer" },
                        },
                        "required": ["id", "buyer", "condition", "quantity", "price"],
                        "type": "object",
                    },
                    "Summary": {
                        "properties": {
                            "count": { "format": "int64", "type": "integer" },
                            "lowest": { "type": ["string", "null"] },
                            "quantity": { "format": "int64", "type": "integer" },
                        },
                        "required": ["lowest", "count", "quantity"],
                        "type": "object",
                    },
                },
                "properties": {
                    "badges": { "items": { "type": "string" }, "type": "array" },
                    "categories": { "items": { "$ref": "#/$defs/Category" }, "type": "array" },
                    "contents": { "items": { "$ref": "#/$defs/ContentLine" }, "type": "array" },
                    "description": { "type": "string" },
                    "fields": { "items": { "$ref": "#/$defs/Field" }, "type": "array" },
                    "id": { "type": "string" },
                    "images": { "items": { "type": "string" }, "type": "array" },
                    "included_in": { "items": { "$ref": "#/$defs/ContentLine" }, "type": "array" },
                    "listings": { "items": { "$ref": "#/$defs/Listing" }, "type": "array" },
                    "offers": { "items": { "$ref": "#/$defs/Offer" }, "type": "array" },
                    "subtitle": { "type": ["string", "null"] },
                    "summary": { "anyOf": [{ "$ref": "#/$defs/Summary" }, { "type": "null" }] },
                    "tags": { "items": { "type": "string" }, "type": "array" },
                    "title": { "type": "string" },
                },
                "required": ["id", "title", "subtitle", "description", "badges", "tags", "categories", "fields", "images", "summary", "listings", "offers", "contents", "included_in"],
                "type": "object",
            }),
            "the nested model types, each a definition of its own, as schemars described them"
        );
        let read = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "items.get", "arguments": { "id": "item_9" } } });
        let (_, _, body) = send(call(Some("dev-token"), read)).await;
        let res: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(res["result"]["structuredContent"]["listings"].as_array().unwrap().len(), 2);
        // The output is written by its ToJson: serde's bytes for the item, in the text block and
        // as is in structuredContent.
        let text = res["result"]["content"][0]["text"].as_str().unwrap();
        let item = fixture().item("item_9").await.unwrap().unwrap();
        assert_eq!(text, serde_json::to_string(&*item).unwrap());
        assert!(body.contains(&format!(r#""structuredContent":{text}"#)), "{body}");
    }

    #[tokio::test]
    async fn other_services_read_an_item_as_json() {
        let app = app();
        let res = app.get(&api::ItemJson { id: "item_9" }).await;
        let (status, headers, body) = read(&res);
        assert_eq!((status, &headers["content-type"]), (StatusCode::OK, &"application/json".parse().unwrap()));
        let item: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!((item["id"].as_str(), item["listings"].as_array().map(Vec::len)), (Some("item_9"), Some(2)));
        // The derived writer gives serde_json's bytes, escapes included.
        let view: ItemView = serde_json::from_str(body).unwrap();
        assert_eq!(body, serde_json::to_string(&view).unwrap());
        assert!(body.contains(r#""title":"Pika <Promo> & \"Friends\"""#), "{body}");
        let res = app.get(&api::ItemJson { id: "nope" }).header(header::ACCEPT, "*/*").await;
        assert_eq!((res.status(), res.text()), (StatusCode::NOT_FOUND, r#"{"title":"Not Found","status":404}"#));
    }

    #[tokio::test]
    async fn the_mcp_endpoint_is_json_only() {
        let app = app();
        let res = app.get(&mcp::Mcp).header(header::ACCEPT, "*/*").await;
        let (status, headers, body) = read(&res);
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            body, r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Method Not Allowed"}}"#,
            "JSON-RPC, as an MCP client reads it, not the HTML error page"
        );
        assert_eq!(headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
        let cross = app
            .call(Method::POST, &mcp::Mcp)
            .header(header::ORIGIN, "https://agent.example")
            .header(SEC_FETCH_SITE, "cross-site")
            .body("application/json", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .await;
        assert_eq!(
            (cross.status(), cross.text()),
            (
                StatusCode::FORBIDDEN,
                r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Cross-site request refused."}}"#
            )
        );
        let deadline = super::rpc_failure(StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable");
        assert_eq!(deadline.error.code, -32603, "the deadline's 503 is the server's failure");
    }

    /// A partner's JSON write, with the key `key` as a bearer token.
    fn partner<'c>(app: &'c App, key: Option<&str>, body: &'static str) -> Call<'c, NoForm> {
        let call = app.call(Method::POST, &api::AlertsJson).body("application/json", body);
        match key {
            Some(key) => call.header(header::AUTHORIZATION, &format!("Bearer {key}")),
            None => call,
        }
    }

    #[tokio::test]
    async fn a_partner_sets_an_alert_with_its_api_key() {
        let app = app();
        let alert = r#"{"id":"item_9","email":"ada@example.com","target_price":"0.40"}"#;
        // No key, or an empty one: send one; a wrong one: it is not valid (RFC 6750 3.1).
        for (key, challenge) in [
            (None, r#"Bearer realm="partners""#),
            (Some(""), r#"Bearer realm="partners""#),
            (Some("wrong"), r#"Bearer realm="partners", error="invalid_token""#),
        ] {
            let res = partner(&app, key, alert).await;
            assert_eq!(
                (res.status(), res.text()),
                (
                    StatusCode::UNAUTHORIZED,
                    r#"{"title":"Unauthorized","status":401,"detail":"Send a valid partner API key as a bearer token."}"#
                )
            );
            assert_eq!(res.headers()[header::WWW_AUTHENTICATE], challenge, "{key:?}");
        }
        let res = partner(&app, Some("dev-key"), alert).await;
        let (status, headers, body) = read(&res);
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body,
            r#"{"message":"Alert set: we will email ada@example.com when Pika <Promo> & \"Friends\" drops below $0.40.","partner":"dev"}"#
        );
        assert_eq!(headers["cache-control"], "private, no-cache", "an answer for one partner");
        // The form's rules, as fields; a missing item; an item with no price to watch.
        let res = partner(&app, Some("dev-key"), r#"{"id":"item_9","email":"ada","target_price":"0"}"#).await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            body.ends_with(
                r#""fields":{"email":"Enter a valid email address.","target_price":"Enter a target price above zero."}}"#
            ),
            "{body}"
        );
        let res = partner(&app, Some("dev-key"), r#"{"id":"nope","email":"ada","target_price":"1"}"#).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = partner(&app, Some("dev-key"), r#"{"id":"item_10","email":"a@b.c","target_price":"1"}"#).await;
        let (status, _, body) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body.contains(r#""form":"This item has no listings yet, so there is no price to watch.""#), "{body}");
    }

    /// The app, limited to `writes` a minute.
    fn limited(writes: u32) -> App {
        let json = json!({ "item_9": { "catalog_item_id": "item_9", "title": "Pika", "market_summary": null } }).to_string();
        let keys = Keys { partners: Partners::parse("dev=dev-key"), agents: "dev-token" };
        super::app_with(Source::fixture(&json).unwrap(), keys, writes).test()
    }

    /// A browser's post of the alert form, with a price the rules refuse.
    fn form_post(app: &App) -> Call<'_, FormBody> {
        let f = AlertInput::FIELDS;
        app.post(&ITEM).header(SEC_FETCH_SITE, "same-origin").field(f.email, "a@b.c").field(f.target_price, "abc")
    }

    #[tokio::test]
    async fn writes_are_limited_per_client_address_and_reads_are_not() {
        let app = limited(2);
        let one = [203, 0, 113, 7];
        for _ in 0..2 {
            assert_eq!(form_post(&app).peer(one).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        // A browser past the limit gets the error page, told when to come back.
        let res = form_post(&app).peer(one).await;
        let wait: u64 = res.headers()["retry-after"].to_str().unwrap().parse().unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!((1..=60).contains(&wait), "{wait}");
        assert!(res.text().contains("<html"), "{}", res.text());
        // A key no partner has is counted by address too, so guessing keys is limited.
        let guess = partner(&app, Some("guess"), "{}").peer(one).await;
        assert_eq!(guess.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(guess.text(), r#"{"title":"Too Many Requests","status":429}"#);
        // Reads, preflights and agents still go through; a read keeps its cache headers.
        let home = app.get(&routes::Home).peer(one).await;
        assert_eq!(
            (home.status(), &home.headers()["cache-control"]),
            (StatusCode::OK, &"public, max-age=60, stale-while-revalidate=600".parse().unwrap())
        );
        assert_eq!(
            app.call(Method::OPTIONS, &api::AlertsJson).peer(one).await.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "no site may call it from a browser"
        );
        let ping = app
            .call(Method::POST, &mcp::Mcp)
            .peer(one)
            .header(header::AUTHORIZATION, "Bearer dev-token")
            .body("application/json", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        assert_eq!(ping.await.status(), StatusCode::OK);
        // Another address has its own count.
        assert_eq!(form_post(&app).peer([203, 0, 113, 8]).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn a_partner_is_counted_as_itself_whatever_address_it_sends_from() {
        let app = limited(1);
        let write =
            || partner(&app, Some("dev-key"), r#"{"id":"nope","email":"a@b.c","target_price":"1"}"#).peer([203, 0, 113, 9]);
        for _ in 0..3 {
            assert_eq!(write().await.status(), StatusCode::NOT_FOUND, "past the address's 1");
        }
        let limit = Counts::new(1, Partners::parse("dev=dev-key"));
        let now = Instant::now();
        for _ in 0..PARTNER_WRITES_PER_MINUTE {
            assert_eq!(limit.count(Client::Partner("dev".into()), now), None);
        }
        assert!(limit.count(Client::Partner("dev".into()), now).is_some(), "a partner has its own limit");
    }

    #[tokio::test]
    async fn a_write_whose_address_is_not_known_is_not_counted() {
        let json = json!({ "item_9": { "catalog_item_id": "item_9", "title": "Pika", "market_summary": null } }).to_string();
        let keys = Keys { partners: Partners::parse(""), agents: "" };
        let app = super::app_with(Source::fixture(&json).unwrap(), keys, 1).test();
        for _ in 0..3 {
            assert_eq!(form_post(&app).await.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
    }

    fn address(ip: &str) -> Client {
        Client::address(ip.parse().unwrap())
    }

    #[test]
    fn a_new_minute_starts_the_count_again() {
        let limit = Counts::new(2, Partners::parse(""));
        let start = Instant::now();
        let ip = || address("198.51.100.1");
        assert_eq!((limit.count(ip(), start), limit.count(ip(), start)), (None, None));
        assert_eq!(limit.count(ip(), start + Duration::from_secs(15)), Some(45), "seconds left in the minute");
        assert_eq!(limit.count(address("198.51.100.2"), start), None, "another address has its own count");
        assert_eq!(limit.count(ip(), start + Duration::from_secs(60)), None);
    }

    #[test]
    fn past_the_cap_a_new_client_waits_for_the_next_minute_and_counted_ones_do_not() {
        let limit = Counts { clients: 2, ..Counts::new(5, Partners::parse("")) };
        let (start, ip) = (Instant::now(), |n: u8| Client::address(IpAddr::from([198, 51, 100, n])));
        assert_eq!((limit.count(ip(1), start), limit.count(ip(2), start)), (None, None));
        assert_eq!(limit.count(ip(3), start + Duration::from_secs(20)), Some(40), "a third client waits");
        assert_eq!(limit.count(ip(1), start), None, "a counted client goes on");
        assert_eq!(limit.count(Client::Partner("dev".into()), start), None, "a partner is not a stranger");
        assert_eq!(limit.count(ip(3), start + Duration::from_secs(60)), None, "and the new minute has room");
    }

    #[test]
    fn an_ipv6_client_is_counted_by_its_64() {
        let limit = Counts::new(1, Partners::parse(""));
        let now = Instant::now();
        assert_eq!(limit.count(address("2001:db8:1:2::1"), now), None);
        assert!(limit.count(address("2001:db8:1:2:ffff::9"), now).is_some(), "the same /64 is the same client");
        assert_eq!(limit.count(address("2001:db8:1:3::1"), now), None, "another /64 is another");
    }

    #[test]
    fn api_keys_without_a_name_or_a_key_are_left_out() {
        let partners = Partners::parse(" shop = k1 ,=k2,blank=, nokey");
        assert_eq!(partners.0.len(), 1);
        assert_eq!(partners.0.get("k1").map(|name| &**name), Some("shop"));
        assert!(Partners::parse("").0.is_empty(), "no API_KEYS, no partners");
    }
}
