mod alerts;
mod model;
mod source;
mod text;
mod trace;
mod views;

use corten::{
    extract::FromRequestParts,
    http::{header, request::Parts},
    i18n::Locale,
    prelude::*,
};
use model::Record;
use source::Source;
use std::sync::Arc;
use text::Msg;
use trace::TraceParent;

#[derive(Clone, corten::FromRef)]
struct AppState {
    source: Source,
    alerts: alerts::Store,
    hardening_edge: bool,
}

const HARDENING_ORIGIN: &str = "https://localhost:8080";

fn hardening_edge(config: Option<&str>) -> bool {
    match config {
        None => false,
        Some(HARDENING_ORIGIN) => true,
        Some(_) => panic!("MARKETPLACE_PUBLIC_ORIGIN must match the Hardening TLS edge"),
    }
}

struct PublicAlertOrigin;

impl FromRequestParts<AppState> for PublicAlertOrigin {
    type Rejection = corten::Error;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if state.hardening_edge {
            let mut hosts = parts.headers.get_all(header::HOST).iter();
            let host = hosts.next();
            if hosts.next().is_some() {
                return Err(Refused::forbidden().into());
            }
            // The separate direct preflight retains Corten's native check.
            if host.is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"localhost:8080")) {
                let mut origin = parts.headers.get_all(header::ORIGIN).iter();
                if !origin.next().is_some_and(|value| value.as_bytes() == HARDENING_ORIGIN.as_bytes()) || origin.next().is_some()
                {
                    return Err(Refused::forbidden().into());
                }
            }
        }
        Ok(Self)
    }
}

#[corten::routes(state = AppState)]
mod routes {
    #[route("/", get = home)]
    pub struct Home;
    #[route("/marketplace/{locale}/{id}", get = show, post = create_alert, no_store(post))]
    pub struct Marketplace<'a> {
        pub locale: corten::i18n::Locale<crate::text::Msg>,
        pub id: &'a str,
        #[route(query)]
        pub query: crate::MarketplaceQuery,
    }
}
#[corten::routes(api = Root, state = AppState)]
mod api {
    #[route("/api")]
    pub struct Root;
    #[route("/api/alerts", get = read_alerts, no_store)]
    pub struct Alerts;
    #[route("/api/marketplace/{id}", get = json)]
    pub struct Record<'a> {
        pub id: &'a str,
    }
}
#[derive(Clone, Default, Route, Fields)]
#[route(query)]
pub struct MarketplaceQuery {
    pub seller: Option<String>,
    pub sort: Option<String>,
    pub offers: Option<String>,
}
impl MarketplaceQuery {
    pub fn descending(&self) -> bool {
        self.sort.as_deref() == Some("desc")
    }
    pub fn all(&self) -> bool {
        self.offers.as_deref() == Some("all")
    }
}
#[derive(Fields)]
pub struct AlertForm {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub target_price: String,
}
async fn home(req: Req) -> HtmlResult {
    req.page(views::document(
        &req,
        "Card Market",
        html! {
            <a href={routes::Marketplace { locale: Locale::parse("en-US").unwrap(), id: "item_1", query: Default::default() }}>
                "Card Market"
            </a>
        },
    ))
}
async fn show(
    req: Req,
    State(source): State<Source>,
    Params(at): Params<routes::Marketplace<'_>>,
    trace: TraceParent,
) -> HtmlResult {
    req.set_locale(at.locale);
    let record = source.record(&at.id, trace.0.as_deref()).await?.ok_or_else(corten::Error::not_found)?;
    let at = routes::Marketplace { locale: at.locale, id: &at.id, query: at.query };
    req.page(views::document(&req, &record.title, views::detail(&req, &record, &at, "")))
}
async fn create_alert(
    req: Req,
    State(state): State<AppState>,
    Params(at): Params<routes::Marketplace<'_>>,
    _: PublicAlertOrigin,
    session: alerts::Session,
    trace: TraceParent,
    Form(form): Form<AlertForm>,
) -> HtmlResult {
    req.set_locale(at.locale);
    let record = state.source.record(&at.id, trace.0.as_deref()).await?.ok_or_else(corten::Error::not_found)?;
    let (message, accepted) = match text::alert(req.t(), &record, &form) {
        Ok((message, target_minor)) => {
            (message, Some(alerts::Alert { item_id: at.id.to_string(), email: form.email, target_minor }))
        }
        Err(message) => (message, None),
    };
    let at = routes::Marketplace { locale: at.locale, id: &at.id, query: at.query };
    let response = req.page(views::document(&req, &record.title, views::detail(&req, &record, &at, &message)))?;
    let cookie = accepted.and_then(|alert| state.alerts.append(&session, alert));
    Ok(match cookie {
        Some(cookie) => response.with_cookie(cookie),
        None => response,
    })
}
async fn read_alerts(State(alerts): State<alerts::Store>, session: alerts::Session) -> JsonResult<Vec<alerts::Alert>> {
    Ok(Json(alerts.read(&session)))
}
async fn json(State(source): State<Source>, Params(at): Params<api::Record<'_>>, trace: TraceParent) -> JsonResult<Arc<Record>> {
    Ok(Json(source.record(&at.id, trace.0.as_deref()).await?.ok_or_else(corten::Error::not_found)?))
}
fn app(source: Source, hardening_edge: bool) -> App {
    let state = AppState { source, alerts: Default::default(), hardening_edge };
    let app = App::new(routes::router(state.clone()))
        .api(|routes| api::api(routes, state))
        .assets(views::Static)
        .messages::<Msg>()
        .components(&[views::SiteHeader]);
    if std::env::var("PROFILE").as_deref() == Ok("matched") {
        let cap = std::env::var("MAX_CONNECTIONS").expect("production benchmark requires MAX_CONNECTIONS");
        app.max_connections(cap.parse().ok().filter(|n| *n > 0).expect("MAX_CONNECTIONS must be positive"))
    } else {
        app
    }
}
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let source = Source::from_env().map_err(|error| std::io::Error::other(error.to_string()))?;
    let origin = std::env::var("MARKETPLACE_PUBLIC_ORIGIN");
    let origin = match origin {
        Ok(origin) => Some(origin),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("MARKETPLACE_PUBLIC_ORIGIN must be valid Unicode"),
    };
    corten::serve(app(source, hardening_edge(origin.as_deref()))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use corten::{
        http::StatusCode,
        i18n::{Decimal, Messages, Minor},
    };
    fn client() -> corten::testing::Client {
        client_with_edge(false)
    }
    fn client_with_edge(hardening_edge: bool) -> corten::testing::Client {
        let record: Record = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        app(Source::Fixture(Arc::new(std::collections::HashMap::from([(record.id.clone(), Arc::new(record))]))), hardening_edge)
            .test()
    }
    fn at(tag: &str) -> routes::Marketplace<'static> {
        routes::Marketplace { locale: Locale::parse(tag).unwrap(), id: "item_1", query: Default::default() }
    }
    #[test]
    fn public_origin_setting_is_the_fixed_benchmark_authority() {
        for origin in ["https://localhost:443", "https://127.1:8443", "https://Localhost:8080", "https://localhost:8080/"] {
            assert!(std::panic::catch_unwind(|| hardening_edge(Some(origin))).is_err(), "{origin}");
        }
        assert!(hardening_edge(Some(HARDENING_ORIGIN)));
        assert!(!hardening_edge(None));
    }
    #[tokio::test]
    async fn public_origin_pin_preserves_direct_alerts_and_requires_https_on_the_public_host() {
        let app = client_with_edge(true);
        let route = at("en-US");
        let fields = AlertForm::FIELDS;
        let post = |host: &str, origin: &str| {
            app.post(&route)
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .field(fields.email, "a@example.test")
                .field(fields.target_price, "1")
        };
        let accepted = post("localhost:8080", HARDENING_ORIGIN).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        let session = accepted.cookie(alerts::COOKIE).unwrap();
        let read = || app.get(&api::Alerts).cookie(alerts::COOKIE, session);
        let before = read().await;
        assert_eq!(serde_json::from_str::<serde_json::Value>(before.text()).unwrap().as_array().unwrap().len(), 1);
        let refused = post("localhost:8080", "http://localhost:8080").cookie(alerts::COOKIE, session).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(read().await.text(), before.text());
        let direct = post("127.0.0.1:8080", "http://127.0.0.1:8080").await;
        assert_eq!(direct.status(), StatusCode::OK);
        let cookie = direct.cookie(alerts::COOKIE).unwrap();
        assert_ne!(app.get(&api::Alerts).cookie(alerts::COOKIE, cookie).await.text(), "[]");
    }
    #[tokio::test]
    async fn rich_page_is_localized_escaped_and_filtered() {
        let app = client();
        for tag in ["en-US", "fr-FR", "de-DE"] {
            let route = at(tag);
            let answer = app.get(&route).await;
            assert_eq!(answer.status(), StatusCode::OK, "{}", answer.text());
            let html = answer.text();
            assert!(html.contains(&format!("lang=\"{tag}\"")));
            assert!(html.contains("Ember &lt;dragon&gt; &amp;"));
            assert_eq!(html.matches("data-listing-id=").count(), 4);
            assert_eq!(html.matches("data-offer-id=").count(), 5);
            assert!(html.contains(&format!("/marketplace/{tag}/item_2")));
            assert!(!html.contains("marketplace__subtitle"));
            let route = routes::Marketplace {
                query: MarketplaceQuery { seller: Some("Al".into()), sort: Some("desc".into()), offers: Some("all".into()) },
                ..route
            };
            let answer = app.get(&route).await;
            let html = answer.text();
            assert_eq!(html.matches("data-listing-id=").count(), 2);
            assert_eq!(html.matches("data-offer-id=").count(), 6);
            assert!(!html.contains("marketplace__more"));
            assert!(html.find("data-listing-id=\"a\"").unwrap() < html.find("data-listing-id=\"b\"").unwrap());
        }
    }
    #[test]
    fn native_formats_match_all_locales_and_half_expand_ratings() {
        let spaces = |s: String| s.replace(['\u{a0}', '\u{202f}'], " ");
        for (tag, money, rating, million) in [
            ("en-US", "$1,234.50", "4.3", "1,000,000 listings"),
            ("fr-FR", "1 234,50 $US", "4,3", "1 000 000 d\u{2019}annonces"),
            ("de-DE", "1.234,50 $", "4,3", "1.000.000 Angebote"),
        ] {
            let t = Msg::for_locale(tag);
            assert_eq!(spaces(t.money(Minor(123450), text::USD).to_string()), money);
            assert_eq!(text::rating(t, 425).to_string(), rating);
            assert_eq!(spaces(t.listing(1000000).to_string()), million);
            assert_eq!(t.number(Decimal::new(5, 0)).to_string(), "5");
        }
    }
    #[tokio::test]
    async fn native_post_form_validates_localized_prices() {
        let app = client();
        let fields = AlertForm::FIELDS;
        for tag in ["en-US", "fr-FR", "de-DE"] {
            let route = at(tag);
            let t = Msg::for_locale(tag);
            let answer = app.post(&route).field(fields.email, "bad").field(fields.target_price, "1").await;
            assert_eq!(answer.status(), StatusCode::OK);
            assert!(answer.text().contains(t.invalid_email()));
            let answer = app.post(&route).field(fields.email, "x@y").field(fields.target_price, "0").await;
            assert_eq!(answer.status(), StatusCode::OK);
            assert!(answer.text().contains(t.invalid_price()));
            let price = if tag == "en-US" { "1234.50" } else { "1234,50" };
            let answer = app.post(&route).field(fields.email, "x@y").field(fields.target_price, price).await;
            assert_eq!(answer.status(), StatusCode::OK);
            assert!(answer.text().contains("x@y"));
            assert!(answer.text().contains(&text::money(t, Some(123450))));
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn accepted_writes_have_independent_session_readback() {
        let app = client();
        let readback = api::Alerts;
        let fresh = app.get(&readback).await;
        assert_eq!(fresh.status(), StatusCode::OK, "{}", fresh.text());
        assert_eq!(fresh.text(), "[]");
        assert!(fresh.headers().get("set-cookie").is_none());
        assert_eq!(fresh.headers()["cache-control"], "private, no-store");
        let chosen = "11111111111111111111111111111111";
        assert_eq!(app.get(&readback).cookie("marketplace-alerts", chosen).await.text(), "[]");
        let fields = AlertForm::FIELDS;
        let invalid = app.post(&at("en-US")).field(fields.email, "bad").field(fields.target_price, "1").await;
        assert_eq!(invalid.status(), StatusCode::OK);
        assert!(invalid.headers().get("set-cookie").is_none());
        assert_eq!(app.get(&readback).await.text(), "[]");
        let accepted = app
            .post(&at("fr-FR"))
            .cookie("marketplace-alerts", chosen)
            .field(fields.email, "a@example.test")
            .field(fields.target_price, "12,50")
            .await;
        let session = accepted.cookie("marketplace-alerts").unwrap();
        assert_ne!(session, chosen);
        let set_cookie = accepted.headers()["set-cookie"].to_str().unwrap();
        for flag in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
            assert!(set_cookie.contains(flag), "{set_cookie}");
        }
        let read = app.get(&readback).cookie("marketplace-alerts", session).await;
        let mut expected = serde_json::json!([{ "item_id": "item_1", "email": "a@example.test", "target_minor": 1250 }]);
        assert_eq!(serde_json::from_str::<serde_json::Value>(read.text()).unwrap(), expected);
        for tag in ["en-US", "fr-FR", "de-DE"] {
            let price = if tag == "en-US" { "1234.50" } else { "1234,50" };
            let email = format!("{tag}@example.test");
            let answer = app
                .post(&at(tag))
                .cookie("marketplace-alerts", session)
                .field(fields.email, &email)
                .field(fields.target_price, price)
                .await;
            assert_eq!(answer.status(), StatusCode::OK);
            assert!(answer.headers().get("set-cookie").is_none());
            expected
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({ "item_id": "item_1", "email": email, "target_minor": 123450 }));
            for (email, price) in [("", ""), ("bad", "1"), ("a@b", "0"), ("a@b", "NaN")] {
                let invalid = app
                    .post(&at(tag))
                    .cookie("marketplace-alerts", session)
                    .field(fields.email, email)
                    .field(fields.target_price, price)
                    .await;
                assert_eq!(invalid.status(), StatusCode::OK);
                assert!(invalid.headers().get("set-cookie").is_none());
                let read = app.get(&readback).cookie("marketplace-alerts", session).await;
                assert_eq!(serde_json::from_str::<serde_json::Value>(read.text()).unwrap(), expected);
            }
        }
        for (header, value) in [
            (corten::http::header::ORIGIN, "https://attacker.test"),
            (corten::http::HeaderName::from_static("sec-fetch-site"), "cross-site"),
        ] {
            let rejected = app
                .post(&at("en-US"))
                .cookie("marketplace-alerts", session)
                .header(header, value)
                .field(fields.email, "evil@example.test")
                .field(fields.target_price, "1")
                .await;
            assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        }
        let missing = app
            .post(&routes::Marketplace { id: "missing", ..at("en-US") })
            .cookie("marketplace-alerts", session)
            .field(fields.email, "missing@example.test")
            .field(fields.target_price, "1")
            .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let unsupported = corten::Local::parse("/marketplace/es-ES/item_1").unwrap();
        assert_eq!(
            app.post(&unsupported)
                .cookie("marketplace-alerts", session)
                .field(fields.email, "locale@example.test")
                .field(fields.target_price, "1")
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        let read = app.get(&readback).cookie("marketplace-alerts", session).await;
        assert_eq!(serde_json::from_str::<serde_json::Value>(read.text()).unwrap(), expected);
        let other = app.post(&at("en-US")).field(fields.email, "other@example.test").field(fields.target_price, "2").await;
        let other_session = other.cookie("marketplace-alerts").unwrap();
        assert_ne!(session, other_session);
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..24 {
            let app = app.clone();
            let session = session.to_string();
            tasks.spawn(async move {
                let answer = app
                    .post(&at("en-US"))
                    .cookie("marketplace-alerts", &session)
                    .field(AlertForm::FIELDS.email, format!("concurrent-{index}@example.test"))
                    .field(AlertForm::FIELDS.target_price, "3.25")
                    .await;
                assert_eq!(answer.status(), StatusCode::OK);
                let read = app.get(&api::Alerts).cookie("marketplace-alerts", &session).await;
                let rows: serde_json::Value = serde_json::from_str(read.text()).unwrap();
                let rows = rows.as_array().unwrap();
                let emails: std::collections::HashSet<_> = rows.iter().map(|row| row["email"].as_str().unwrap()).collect();
                assert_eq!(rows.len(), emails.len());
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        let read = app.get(&readback).cookie("marketplace-alerts", session).await;
        let actual: serde_json::Value = serde_json::from_str(read.text()).unwrap();
        let rows = actual.as_array().unwrap();
        let prefix = expected.as_array().unwrap();
        assert_eq!(&rows[..prefix.len()], prefix);
        assert_eq!(rows.len(), prefix.len() + 24);
        for index in 0..24 {
            assert_eq!(
                rows.iter()
                    .filter(|row| row["email"] == format!("concurrent-{index}@example.test") && row["target_minor"] == 325)
                    .count(),
                1
            );
        }
        assert_eq!(read.text(), app.get(&readback).cookie("marketplace-alerts", session).await.text());
        for count in 1..=2 {
            let duplicate = app
                .post(&at("en-US"))
                .cookie("marketplace-alerts", session)
                .field(fields.email, "repeat@example.test")
                .field(fields.target_price, "4")
                .await;
            assert_eq!(duplicate.status(), StatusCode::OK);
            let read = app.get(&readback).cookie("marketplace-alerts", session).await;
            let rows: serde_json::Value = serde_json::from_str(read.text()).unwrap();
            assert_eq!(rows.as_array().unwrap().len(), prefix.len() + 24 + count);
            assert_eq!(
                rows.as_array().unwrap().last().unwrap(),
                &serde_json::json!({
                    "item_id": "item_1", "email": "repeat@example.test", "target_minor": 400
                })
            );
        }
        let other = app.get(&readback).cookie("marketplace-alerts", other_session).await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(other.text()).unwrap(),
            serde_json::json!([{ "item_id": "item_1", "email": "other@example.test", "target_minor": 200 }])
        );
        assert_eq!(app.get(&readback).await.text(), "[]");
        assert_eq!(app.get(&readback).cookie("marketplace-alerts", chosen).await.text(), "[]");
    }
    #[tokio::test]
    async fn local_http_form_sets_a_browser_usable_session_cookie() {
        let app = client();
        let answer = app
            .post(&at("en-US"))
            .header(corten::http::header::HOST, "localhost")
            .header(corten::http::header::ORIGIN, "http://localhost")
            .field(AlertForm::FIELDS.email, "http@example.test")
            .field(AlertForm::FIELDS.target_price, "1.25")
            .await;
        assert_eq!(answer.status(), StatusCode::OK, "{}", answer.text());
        let cookie = answer.headers()["set-cookie"].to_str().unwrap();
        assert!(!cookie.contains("Secure"), "{cookie}");
        assert!(cookie.contains("HttpOnly"));
        let session = answer.cookie(alerts::COOKIE).unwrap();
        let read = app.get(&api::Alerts).cookie(alerts::COOKIE, session).await;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(read.text()).unwrap(),
            serde_json::json!([{ "item_id": "item_1", "email": "http@example.test", "target_minor": 125 }])
        );
    }
    #[tokio::test]
    async fn canonical_json_missing_records_and_unsupported_locale() {
        let app = client();
        let answer = app.get(&api::Record { id: "item_1" }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        let actual: serde_json::Value = serde_json::from_str(answer.text()).unwrap();
        let expected: serde_json::Value = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(app.get(&api::Record { id: "missing" }).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(app.get(&routes::Marketplace { id: "missing", ..at("en-US") }).await.status(), StatusCode::NOT_FOUND);
        let unsupported = corten::Local::parse("/marketplace/es-ES/item_1").unwrap();
        assert_eq!(app.get(&unsupported).await.status(), StatusCode::BAD_REQUEST);
    }

    /// How long the marketplace fixture (`bench/marketplace/upstream.mjs`, Node's HTTP server) says it
    /// keeps an idle connection open: it answers with `Keep-Alive: timeout=5`.
    const FIXTURE_KEEP_ALIVE: std::time::Duration = std::time::Duration::from_secs(5);

    /// What the upstream did, in milliseconds from its start, on which of its connections.
    #[derive(Clone, Debug, PartialEq)]
    enum Seen {
        Accepted,
        Answered(String),
        /// A request arrived on a connection idle this long, and the connection closed unanswered.
        ClosedIdle(u128),
        ClosedByClient,
    }

    type Log = Arc<std::sync::Mutex<Vec<(u128, usize, Seen)>>>;

    /// The fixture's idle close, made deterministic. The fixture closes a connection that has been
    /// idle for its keep-alive timeout; a request written to it in that instant never reaches its
    /// handler. Here every request that arrives on a connection idle for at least
    /// [`FIXTURE_KEEP_ALIVE`] meets that close: the connection is dropped with the request unread,
    /// which resets it, and nothing answers. A request on a fresh or recently used connection is
    /// answered with `body`, and the connection kept open. Each answer is logged before it is
    /// written, and [`ClosingUpstream::stop`] joins every thread before the log is read, so the log
    /// is complete when the test inspects it. Dropping it (also when a test fails early) stops and
    /// joins every thread as well.
    struct ClosingUpstream {
        at: String,
        started: std::time::Instant,
        stopping: Arc<std::sync::atomic::AtomicBool>,
        accepting: Option<std::thread::JoinHandle<()>>,
        seen: Log,
    }

    impl ClosingUpstream {
        fn start(body: &'static str) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let at = format!("http://{}", listener.local_addr().unwrap());
            let (started, seen, stopping) =
                (std::time::Instant::now(), Log::default(), Arc::<std::sync::atomic::AtomicBool>::default());
            let (log, stop) = (seen.clone(), stopping.clone());
            let accepting = std::thread::spawn(move || {
                let (mut connections, mut failure) = (Vec::new(), None);
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            let (log, stop, connection) = (log.clone(), stop.clone(), connections.len());
                            connections.push(std::thread::spawn(move || serve(socket, connection, body, started, &log, &stop)));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5))
                        }
                        Err(error) => {
                            failure = Some(format!("accept: {error}"));
                            stop.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
                let panicked = connections.into_iter().map(std::thread::JoinHandle::join).filter(Result::is_err).count();
                assert!(failure.is_none() && panicked == 0, "{failure:?}; {panicked} connection threads panicked");
            });
            Self { at, started, stopping, accepting: Some(accepting), seen }
        }

        fn now(&self) -> u128 {
            self.started.elapsed().as_millis()
        }

        /// Stops accepting and waits for every thread to end: each connection's thread checks within
        /// [`POLL`] while it waits for a request, and a write gives up after [`WRITE`].
        fn halt(&mut self) -> std::thread::Result<()> {
            self.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
            self.accepting.take().map_or(Ok(()), std::thread::JoinHandle::join)
        }

        /// Stops, then returns everything the upstream did.
        fn stop(mut self) -> Vec<(u128, usize, Seen)> {
            self.halt().expect("an upstream thread panicked");
            self.seen.lock().unwrap().clone()
        }
    }

    impl Drop for ClosingUpstream {
        fn drop(&mut self) {
            // A panic here while a failed test unwinds would abort; that failure is already reported.
            if self.halt().is_err() && !std::thread::panicking() {
                panic!("an upstream thread panicked");
            }
        }
    }

    /// How often a connection's thread, waiting for a request, checks whether the upstream is stopping.
    const POLL: std::time::Duration = std::time::Duration::from_millis(20);
    /// How long a connection's thread waits to write an answer before it gives up.
    const WRITE: std::time::Duration = std::time::Duration::from_secs(2);

    /// The connections that answered a `line` request.
    fn connections(seen: &[(u128, usize, Seen)], line: &str) -> Vec<usize> {
        let answered = Seen::Answered(line.into());
        let mut found: Vec<usize> = seen.iter().filter_map(|(_, c, s)| (*s == answered).then_some(*c)).collect();
        found.sort_unstable();
        found.dedup();
        found
    }

    /// The idle closes logged at or after `from` ms.
    fn closed_since(seen: &[(u128, usize, Seen)], from: u128) -> usize {
        seen.iter().filter(|(at, _, s)| matches!(s, Seen::ClosedIdle(_)) && *at >= from).count()
    }

    fn serve(
        mut socket: std::net::TcpStream,
        connection: usize,
        body: &str,
        started: std::time::Instant,
        log: &std::sync::Mutex<Vec<(u128, usize, Seen)>>,
        stopping: &std::sync::atomic::AtomicBool,
    ) {
        use std::io::{ErrorKind, Read, Write};
        let record = |seen| log.lock().unwrap().push((started.elapsed().as_millis(), connection, seen));
        let waiting = |error: &std::io::Error| matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut);
        let stopped = || stopping.load(std::sync::atomic::Ordering::SeqCst);
        record(Seen::Accepted);
        socket.set_nonblocking(false).unwrap();
        socket.set_read_timeout(Some(POLL)).unwrap();
        socket.set_write_timeout(Some(WRITE)).unwrap();
        let mut answered: Option<std::time::Instant> = None;
        loop {
            match socket.peek(&mut [0]) {
                Ok(1) => {}
                Err(error) if waiting(&error) && !stopped() => continue,
                Err(error) if waiting(&error) => return,
                _ => return record(Seen::ClosedByClient),
            }
            if let Some(idle) = answered.map(|at| at.elapsed()).filter(|idle| *idle >= FIXTURE_KEEP_ALIVE) {
                return record(Seen::ClosedIdle(idle.as_millis()));
            }
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                match socket.read(&mut byte) {
                    Ok(1) => head.push(byte[0]),
                    Err(error) if waiting(&error) && !stopped() => {}
                    Err(error) if waiting(&error) => return,
                    other => panic!("the request head ended early: {other:?}"),
                }
            }
            let line = String::from_utf8(head).unwrap().lines().next().unwrap().to_string();
            let length = body.len();
            record(Seen::Answered(line));
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {length}\r\nkeep-alive: timeout=5\r\n\r\n{body}")
                .unwrap();
            answered = Some(std::time::Instant::now());
        }
    }

    /// An item's JSON whose upstream connection sat idle past the fixture's keep-alive is answered
    /// from a new connection with one upstream request, not failed with a 500 (#1893). The control
    /// is the same item through the same handler with the pool policy before that change (reqwest's
    /// default of 90 s): it reuses the connection the upstream closed, and the item fails.
    #[tokio::test]
    async fn json_after_the_upstream_s_keep_alive_does_not_reuse_its_closed_connection() {
        const ITEM: &str = include_str!("../tests/marketplace.json");
        assert!(source::UPSTREAM_IDLE < FIXTURE_KEEP_ALIVE);
        let (fixed_upstream, old_upstream) = (ClosingUpstream::start(ITEM), ClosingUpstream::start(ITEM));
        let fixed = app(Source::api(&fixed_upstream.at).unwrap(), false).test();
        let old = app(Source::api_pooled(&old_upstream.at, None).unwrap(), false).test();
        let item = api::Record { id: "item_1" };
        assert_eq!(fixed.get(&item).await.status(), StatusCode::OK);
        assert_eq!(old.get(&item).await.status(), StatusCode::OK);
        tokio::time::sleep(FIXTURE_KEEP_ALIVE + std::time::Duration::from_millis(250)).await;
        let sent = (fixed_upstream.now(), old_upstream.now());
        let (answer, failed) = (fixed.get(&item).await.status(), old.get(&item).await.status());
        let (seen, old_seen, line) = (fixed_upstream.stop(), old_upstream.stop(), "GET /marketplace/records/item_1 HTTP/1.1");
        assert_eq!(failed, StatusCode::INTERNAL_SERVER_ERROR, "old policy, sent at {} ms: {old_seen:?}", sent.1);
        assert_eq!((closed_since(&old_seen, sent.1), connections(&old_seen, line).len()), (1, 1), "{old_seen:?}");
        assert_eq!(answer, StatusCode::OK, "sent at {} ms; upstream: {seen:?}", sent.0);
        assert_eq!(closed_since(&seen, sent.0), 0, "{seen:?}");
        let answers = seen.iter().filter(|(_, _, s)| *s == Seen::Answered(line.into())).count();
        assert_eq!(
            (answers, connections(&seen, line).len()),
            (2, 2),
            "one upstream request per item, on a new connection: {seen:?}"
        );
    }
}
