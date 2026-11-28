mod catalog;
mod marketplace;
mod source;

use ntex::web::{self, App, HttpResponse, HttpServer, types::Path};
use serde::Serialize;
use source::Source;
use std::sync::{Arc, OnceLock};

static CATALOG: OnceLock<Source<catalog::Record>> = OnceLock::new();
static MARKET: OnceLock<Source<marketplace::Record>> = OnceLock::new();

fn json<T: Serialize>(result: Result<Option<Arc<T>>, Box<dyn std::error::Error>>) -> HttpResponse {
    match result {
        Ok(Some(record)) => HttpResponse::Ok().json(&record),
        Ok(None) => HttpResponse::NotFound().json(&serde_json::json!({"status":404,"title":"Not Found"})),
        Err(_) => HttpResponse::BadGateway().json(&serde_json::json!({"status":502,"title":"Bad Gateway"})),
    }
}

#[ntex::main]
async fn main() -> std::io::Result<()> {
    let catalog = CATALOG.get_or_init(|| Source::load("catalog"));
    let market = MARKET.get_or_init(|| Source::load("marketplace"));
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    HttpServer::new(async move |_| {
        App::new()
            .middleware(web::middleware::Compress::default())
            .service(
                web::resource("/api/catalog/{id}")
                    .route(web::get().to(async move |id: Path<String>| json(catalog.get(&id).await))),
            )
            .service(
                web::resource("/api/marketplace/{id}")
                    .route(web::get().to(async move |id: Path<String>| json(market.get(&id).await))),
            )
    })
    .bind(format!("0.0.0.0:{port}"), ntex::SharedCfg::new("json-api"))?
    .run()
    .await
}
