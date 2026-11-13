mod alerts;
mod model;
mod source;
mod text;
mod views;

use corten::i18n::Locale;
use corten::prelude::*;
use model::Record;
use source::Source;
use std::sync::Arc;
use text::Msg;

#[derive(Clone, corten::FromRef)]
struct AppState {
    source: Source,
    alerts: alerts::Store,
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
async fn show(req: Req, State(source): State<Source>, Params(at): Params<routes::Marketplace<'_>>) -> HtmlResult {
    req.set_locale(at.locale);
    let record = source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
    let at = routes::Marketplace { locale: at.locale, id: &at.id, query: at.query };
    req.page(views::document(&req, &record.title, views::detail(&req, &record, &at, "")))
}
async fn create_alert(
    req: Req,
    State(state): State<AppState>,
    Params(at): Params<routes::Marketplace<'_>>,
    session: alerts::Session,
    Form(form): Form<AlertForm>,
) -> HtmlResult {
    req.set_locale(at.locale);
    let record = state.source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
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
async fn json(State(source): State<Source>, Params(at): Params<api::Record<'_>>) -> JsonResult<Arc<Record>> {
    Ok(Json(source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?))
}
fn app(source: Source) -> App {
    let state = AppState { source, alerts: Default::default() };
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
    corten::serve(app(source)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use corten::{
        http::StatusCode,
        i18n::{Decimal, Messages, Minor},
    };
    fn client() -> corten::testing::Client {
        let record: Record = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        app(Source::Fixture(Arc::new(std::collections::HashMap::from([(record.id.clone(), Arc::new(record))])))).test()
    }
    fn at(tag: &str) -> routes::Marketplace<'static> {
        routes::Marketplace { locale: Locale::parse(tag).unwrap(), id: "item_1", query: Default::default() }
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
        assert_eq!(fresh.headers()["cache-control"], "no-store");
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
}
