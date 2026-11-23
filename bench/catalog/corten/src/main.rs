mod source;
mod views;

use corten::prelude::*;
use source::{Record, Source};
use std::sync::Arc;

#[corten::routes(state = source::Source)]
mod routes {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/files/sitemap.xml", get = sitemap)]
    pub struct Sitemap;

    #[route("/files/export.csv", get = export)]
    pub struct Export;

    #[route("/files/picture.png", get = picture)]
    pub struct Picture;

    #[route("/files/small.png", get = small)]
    pub struct Small;

    #[route("/files/large.png", get = large)]
    pub struct Large;

    #[route("/kept/{id}", get = kept)]
    pub struct Kept<'a> {
        pub id: &'a str,
    }

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

/// The record's page, the same for everyone for a minute.
async fn kept(req: Req, State(source): State<Source>, Params(at): Params<routes::Kept<'_>>) -> corten::Public<HtmlResult> {
    let page = async {
        let record = source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
        req.page(views::document(&req, &record.title, views::record(&record, "")))
    }
    .await;
    corten::Public::new(std::time::Duration::from_secs(60), page)
}

/// A sitemap of 500 URLs, written for each request.
async fn sitemap() -> corten::Public<corten::seo::File> {
    let urls: Vec<String> = (0..500).map(|i| format!("https://example.com/catalog/record_{i}")).collect();
    corten::seo::sitemap(urls.iter().map(|loc| corten::seo::SitemapUrl { loc, lastmod: Some("2026-11-01") }))
}

static CSV: std::sync::LazyLock<corten::http::Bytes> = std::sync::LazyLock::new(|| {
    corten::http::Bytes::from((0..400).map(|i| format!("{i},card {i},{}\n", i * 7)).collect::<String>())
});

/// A CSV the app holds: its handler makes nothing.
async fn export() -> corten::Public<corten::Media> {
    corten::Public::new(std::time::Duration::from_secs(60), corten::Media::new("text/csv", CSV.clone()))
}

/// Bytes that do not compress, as a picture's do not.
fn noise(length: usize) -> corten::http::Bytes {
    let mut state = 0x9E37_79B9u32;
    let bytes: Vec<u8> = (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect();
    corten::http::Bytes::from(bytes)
}

static PNG: std::sync::LazyLock<corten::http::Bytes> = std::sync::LazyLock::new(|| noise(8000));
static SMALL: std::sync::LazyLock<corten::http::Bytes> = std::sync::LazyLock::new(|| noise(1024));
static LARGE: std::sync::LazyLock<corten::http::Bytes> = std::sync::LazyLock::new(|| noise(1 << 20));

/// A picture the app holds, of a type no build compresses.
async fn picture() -> corten::Public<corten::Media> {
    corten::Public::new(std::time::Duration::from_secs(14_400), corten::Media::new("image/png", PNG.clone()))
}

/// The same of 1,024 bytes.
async fn small() -> corten::Public<corten::Media> {
    corten::Public::new(std::time::Duration::from_secs(60), corten::Media::new("image/png", SMALL.clone()))
}

/// The same of 1 MiB.
async fn large() -> corten::Public<corten::Media> {
    corten::Public::new(std::time::Duration::from_secs(60), corten::Media::new("image/png", LARGE.clone()))
}

async fn json(State(source): State<Source>, Params(at): Params<api::Record<'_>>) -> JsonResult<Arc<Record>> {
    Ok(Json(source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?))
}

fn app(source: Source, lean: bool) -> App {
    let app = App::new(routes::router(source.clone()))
        .api(|routes| api::api(routes, source))
        .assets(views::Static)
        .components(&[views::SiteHeader]);
    if lean {
        app.deadline(None).header_timeout(None).send_timeout(None)
    } else {
        app
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let source = Source::from_env().map_err(|error| std::io::Error::other(error.to_string()))?;
    let lean = std::env::var("PROFILE").as_deref() == Ok("catalog-lean");
    corten::serve(app(source, lean)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use corten::http::StatusCode;
    use serde_json::json;

    fn application() -> corten::testing::Client {
        application_with_profile(false)
    }

    fn application_with_profile(lean: bool) -> corten::testing::Client {
        let record = json!({
            "id": "record_1", "title": "Trail <script> & friends", "subtitle": "Notes",
            "description": "<img src=x onerror=alert(1)>", "tags": ["a&b"],
            "fields": [{"name":"Access","value":"North"},{"name":"access","value":"South"}],
            "related": [{"id":"record_2","title":"Other <trail>"}]
        });
        let data = serde_json::from_value(json!({"record_1": record})).unwrap();
        app(Source::Fixture(Arc::new(data)), lean).test()
    }

    #[tokio::test]
    async fn lean_and_default_profiles_keep_page_and_json_contracts() {
        for lean in [false, true] {
            let app = application_with_profile(lean);
            let page = app.get(&routes::Catalog { id: "record_1", query: CatalogQuery::default() }).await;
            assert_eq!(page.status(), StatusCode::OK);
            assert!(page.text().contains("Trail &lt;script&gt; &amp; friends"));
            assert!(page.headers().contains_key("content-security-policy"));
            assert_eq!(page.headers()["x-content-type-options"], "nosniff");
            assert_eq!(app.get(&api::Record { id: "record_1" }).await.status(), StatusCode::OK);
            assert_eq!(app.get(&api::Record { id: "missing" }).await.status(), StatusCode::NOT_FOUND);
        }
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
        assert!(answer.headers().contains_key("content-security-policy"));
        assert_eq!(answer.headers()["x-content-type-options"], "nosniff");
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
