mod source;
mod views;

use corten::prelude::*;
use source::{Record, Source};
use std::sync::Arc;

#[corten::routes(state = source::Source)]
mod routes {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/catalog/{id}", get = show)]
    pub struct Catalog<'a> {
        pub id: &'a str,
        #[route(query)]
        pub query: crate::CatalogQuery,
    }
}

#[corten::routes(api = Root, state = source::Source)]
mod api {
    #[route("/api")]
    pub struct Root;

    #[route("/api/catalog/{id}", get = json)]
    pub struct Record<'a> {
        pub id: &'a str,
    }
}

#[derive(Clone, Default, Route, Fields)]
#[route(query)]
pub struct CatalogQuery {
    pub field: Option<String>,
}

async fn home(req: Req) -> HtmlResult {
    req.page(views::document(
        &req,
        "Catalog",
        html! {
            <h1>"Catalog"</h1>
            <a href={routes::Catalog { id: "record_1", query: CatalogQuery::default() }}>"Open a record"</a>
        },
    ))
}

async fn show(req: Req, State(source): State<Source>, Params(at): Params<routes::Catalog<'_>>) -> HtmlResult {
    let record = source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
    req.page(views::document(&req, &record.title, views::record(&record, at.query.field.as_deref().unwrap_or(""))))
}

async fn json(State(source): State<Source>, Params(at): Params<api::Record<'_>>) -> JsonResult<Arc<Record>> {
    Ok(Json(source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?))
}

fn app(source: Source) -> App {
    App::new(routes::router(source.clone()))
        .api(|routes| api::api(routes, source))
        .assets(views::Static)
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
    use corten::http::StatusCode;
    use serde_json::json;

    fn application() -> corten::testing::Client {
        let record = json!({
            "id": "record_1", "title": "Trail <script> & friends", "subtitle": "Notes",
            "description": "<img src=x onerror=alert(1)>", "tags": ["a&b"],
            "fields": [{"name":"Access","value":"North"},{"name":"access","value":"South"}],
            "related": [{"id":"record_2","title":"Other <trail>"}]
        });
        let data = serde_json::from_value(json!({"record_1": record})).unwrap();
        app(Source::Fixture(Arc::new(data))).test()
    }

    #[tokio::test]
    async fn renders_all_fields_and_escapes_text() {
        let answer = application().get(&routes::Catalog { id: "record_1", query: CatalogQuery::default() }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        let html = answer.text();
        assert!(html.contains("Trail &lt;script&gt; &amp; friends"));
        assert!(!html.contains("<img src=x"));
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(html.contains("<th scope=\"row\">Access</th>"));
        assert!(html.contains("<th scope=\"row\">access</th>"));
        assert!(html.contains("href=\"/catalog/record_2\""));
    }

    #[tokio::test]
    async fn prefix_is_case_sensitive_and_retained() {
        let answer =
            application().get(&routes::Catalog { id: "record_1", query: CatalogQuery { field: Some("A".into()) } }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        assert!(answer.text().contains("value=\"A\""));
        assert!(answer.text().contains("<th scope=\"row\">Access</th>"));
        assert!(!answer.text().contains("<th scope=\"row\">access</th>"));
    }

    #[tokio::test]
    async fn json_keeps_strings_and_missing_records_are_404() {
        let app = application();
        let answer = app.get(&api::Record { id: "record_1" }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        let record: serde_json::Value = serde_json::from_str(answer.text()).unwrap();
        assert_eq!(record["title"], "Trail <script> & friends");
        assert_eq!(record["fields"].as_array().unwrap().len(), 2);
        assert_eq!(app.get(&api::Record { id: "missing" }).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            app.get(&routes::Catalog { id: "missing", query: CatalogQuery::default() }).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}
