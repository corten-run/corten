//! Where items come from. ITEM_SOURCE=fixture: the item API's responses from FIXTURE_PATH,
//! converted once at start, so the benchmark measures the web server alone. Otherwise every
//! request fetches the item from the item API at API_BASE.
use std::{collections::HashMap, sync::Arc};

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::model::ItemView;

pub enum Items {
    Fixture(HashMap<String, Arc<ItemView>>),
    Api { client: reqwest::Client, base: reqwest::Url },
}

/// The item API failed or answered with something other than an item or a 404.
pub struct ApiError(String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        eprintln!("item API: {}", self.0);
        (StatusCode::BAD_GATEWAY, "The item API did not answer.").into_response()
    }
}

impl Items {
    pub fn from_env() -> Self {
        if std::env::var("ITEM_SOURCE").as_deref() == Ok("fixture") {
            let path = std::env::var("FIXTURE_PATH").unwrap_or_else(|_| "fixtures/items.json".into());
            let text = std::fs::read_to_string(path).expect("fixture file");
            // One item at a time, so the whole file's parsed JSON never sits in memory at once.
            let raw: HashMap<String, &serde_json::value::RawValue> = serde_json::from_str(&text).expect("fixture JSON");
            let items = raw
                .into_iter()
                .map(|(id, v)| (id, Arc::new(ItemView::from_api(&serde_json::from_str(v.get()).expect("fixture item")))))
                .collect();
            return Items::Fixture(items);
        }
        let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://localhost:8080".into());
        Items::Api { client: reqwest::Client::new(), base: base.parse().expect("API_BASE is a URL") }
    }

    /// The items the home page shows as cards: the first 50 by id with items in memory, none from
    /// the item API (which cannot list items).
    pub fn shelf(&self) -> Vec<&ItemView> {
        let Items::Fixture(items) = self else { return Vec::new() };
        (1..=50).filter_map(|n| items.get(&format!("item_{n}")).map(|item| &**item)).collect()
    }

    /// One item, shared rather than copied, or none when there is no such item.
    pub async fn get(&self, id: &str) -> Result<Option<Arc<ItemView>>, ApiError> {
        let (client, base) = match self {
            Items::Fixture(items) => return Ok(items.get(id).cloned()),
            Items::Api { client, base } => (client, base),
        };
        let mut url = base.clone();
        url.path_segments_mut().map_err(|()| ApiError(format!("{base} cannot be a base")))?.pop_if_empty().extend([
            "api",
            "discovery",
            "items",
            id,
        ]);
        let res = client.get(url).send().await.map_err(|e| ApiError(e.to_string()))?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !res.status().is_success() {
            return Err(ApiError(format!("returned {}", res.status())));
        }
        let value: serde_json::Value = res.json().await.map_err(|e| ApiError(e.to_string()))?;
        Ok(Some(Arc::new(ItemView::from_api(&value))))
    }
}
