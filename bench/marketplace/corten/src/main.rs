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

#[corten::routes(state = source::Source)]
mod routes {
    #[route("/", get = home)]
    pub struct Home;
    #[route("/marketplace/{locale}/{id}", get = show, post = create_alert)]
    pub struct Marketplace<'a> {
        pub locale: corten::i18n::Locale<crate::text::Msg>,
        pub id: &'a str,
        #[route(query)]
        pub query: crate::MarketplaceQuery,
    }
}
#[corten::routes(api = Root, state = source::Source)]
mod api {
    #[route("/api")]
    pub struct Root;
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
    req.page(views::document(&req, "Card Market", html! {
        <a href={routes::Marketplace { locale: Locale::parse("en-US").unwrap(), id: "item_1", query: Default::default() }}>
            "Card Market"
        </a>
    }))
}
async fn show(req: Req, State(source): State<Source>, Params(at): Params<routes::Marketplace<'_>>) -> HtmlResult {
    req.set_locale(at.locale);
    let record = source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
    let at = routes::Marketplace { locale: at.locale, id: &at.id, query: at.query };
    req.page(views::document(&req, &record.title, views::detail(&req, &record, &at, "")))
}
async fn create_alert(
    req: Req,
    State(source): State<Source>,
    Params(at): Params<routes::Marketplace<'_>>,
    Form(form): Form<AlertForm>,
) -> HtmlResult {
    req.set_locale(at.locale);
    let record = source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
    let message = text::alert(req.t(), &record, &form);
    let at = routes::Marketplace { locale: at.locale, id: &at.id, query: at.query };
    req.page(views::document(&req, &record.title, views::detail(&req, &record, &at, &message)))
}
async fn json(State(source): State<Source>, Params(at): Params<api::Record<'_>>) -> JsonResult<Arc<Record>> {
    Ok(Json(source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?))
}
fn app(source: Source) -> App {
    App::new(routes::router(source.clone()))
        .api(|routes| api::api(routes, source))
        .assets(views::Static)
        .messages::<Msg>()
        .components(&[views::SiteHeader])
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
