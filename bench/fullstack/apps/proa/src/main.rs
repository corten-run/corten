use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use proa::{DataLoader, WebContext, WebRenderSync, WriteError, html_sync};
use proa_framework_axum::{FrameworkBuilder, RouteResponse};
use serde::Deserialize;
use std::sync::Arc;
use tower_http::services::ServeDir;

mod catalog;
mod source;

struct Page(Arc<catalog::Record>, String);

impl<L: DataLoader> WebRenderSync<L> for Page {
    fn render(self, cx: &mut WebContext<L>) -> Result<(), WriteError> {
        let record = &self.0;
        let prefix = &self.1;
        let action = format!("/catalog/{}", record.id);
        html_sync! {
            <!DOCTYPE html>
            <html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
            <title>{record.title.as_str()}</title>
            <link rel="stylesheet" href="/static/style.css"/><link rel="stylesheet" href="/static/components.css"/>
            <link rel="stylesheet" href="/static/catalog.css"/></head><body>
            <header class="site-header__bar"><a href="/">"Card Market"</a></header>
            <main><article aria-label="Catalog record"><h1>{record.title.as_str()}</h1>
            <p>{record.subtitle.as_str()}</p><p>{record.description.as_str()}</p>
            <ul aria-label="Tags">{for tag in &record.tags {
                html_sync! { <li>{tag.as_str()}</li> }.render(cx)?;
            }}</ul>
            <form method="get" action={action}>
                <label>"Field name "<input type="text" name="field" value={prefix.as_str()}/></label>
                <button type="submit">"Filter"</button></form>
            <table><caption>"Record fields"</caption><thead><tr><th scope="col">"Name"</th><th scope="col">"Value"</th></tr></thead>
            <tbody>{for field in record.fields.iter().filter(|f| f.name.starts_with(prefix)) {
                html_sync! { <tr><th scope="row">{field.name.as_str()}</th><td>{field.value.as_str()}</td></tr> }.render(cx)?;
            }}</tbody></table><nav aria-label="Related records"><ul>{for related in &record.related {
                let href = format!("/catalog/{}", related.id);
                html_sync! { <li><a href={href}>{related.title.as_str()}</a></li> }.render(cx)?;
            }}</ul></nav></article></main></body></html>
        }.render(cx)
    }
}

type Records = Arc<source::Source<catalog::Record>>;
#[derive(Default, Deserialize)]
struct Filter {
    #[serde(default)]
    field: String,
}

async fn page(State(source): State<Records>, Path(id): Path<String>, Query(filter): Query<Filter>) -> Response {
    match source.get(&id).await {
        Ok(Some(record)) => (
            [
                ("cache-control", "private, no-cache"),
                ("cross-origin-opener-policy", "same-origin"),
                ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
            ],
            RouteResponse::ssr(Page(record, filter.field)),
        )
            .into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn json(State(source): State<Records>, Path(id): Path<String>) -> Response {
    match source.get(&id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"status":404}))).into_response(),
        Err(_) => (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"status":502}))).into_response(),
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let routes = Router::new()
        .route("/catalog/{id}", get(page))
        .route("/api/catalog/{id}", get(json))
        .nest_service("/static", ServeDir::new("static"))
        .with_state(Arc::new(source::Source::load("catalog")));
    let app = FrameworkBuilder::new().with_dynamic_routes(routes).with_strict_csp().build();
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    axum::serve(tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?, app).await
}
