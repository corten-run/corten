//! Where items come from. ITEM_SOURCE=fixture: the item API's responses from FIXTURE_PATH,
//! converted once at start, so the benchmark measures the web server alone. Otherwise every
//! request fetches the item from the item API at API_BASE.
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

use topcoat::{
    Error, Result,
    context::{Cx, memoize},
};

use crate::model::ItemView;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static API_BASE: OnceLock<reqwest::Url> = OnceLock::new();
static FIXTURE: OnceLock<Option<HashMap<String, Arc<ItemView>>>> = OnceLock::new();

/// Reads the fixture and API_BASE, so a bad one stops the server before it listens.
pub fn init() {
    if fixture().is_none() {
        api_base();
    }
}

fn api_base() -> &'static reqwest::Url {
    API_BASE.get_or_init(|| {
        let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://localhost:8080".into());
        base.parse().expect("API_BASE is a URL")
    })
}

/// The fixture's items, or none when items come from the item API.
pub fn fixture() -> Option<&'static HashMap<String, Arc<ItemView>>> {
    FIXTURE
        .get_or_init(|| {
            if std::env::var("ITEM_SOURCE").as_deref() != Ok("fixture") {
                return None;
            }
            let path = std::env::var("FIXTURE_PATH").unwrap_or_else(|_| "fixtures/items.json".into());
            let text = std::fs::read_to_string(path).expect("fixture file");
            // One item at a time, so the whole file's parsed JSON never sits in memory at once.
            let raw: HashMap<String, &serde_json::value::RawValue> = serde_json::from_str(&text).expect("fixture JSON");
            let items = raw
                .into_iter()
                .map(|(id, v)| (id, Arc::new(ItemView::from_api(&serde_json::from_str(v.get()).expect("fixture item")))))
                .collect();
            Some(items)
        })
        .as_ref()
}

/// The items the home page shows as cards: the first 50 by id with items in memory, none from
/// the item API (which cannot list items).
pub fn shelf() -> Vec<&'static ItemView> {
    let Some(items) = fixture() else { return Vec::new() };
    (1..=50).filter_map(|n| items.get(&format!("item_{n}")).map(|item| &**item)).collect()
}

/// One item, borrowed for the rest of the request.
pub async fn get<'a>(cx: &'a Cx, id: &str) -> Result<Option<&'a ItemView>> {
    match item(cx, id).await {
        Ok(item) => Ok(item.as_deref()),
        Err(error) => Err(error.clone()),
    }
}

/// One item, shared: the JSON route serializes it where it is.
pub async fn shared(cx: &Cx, id: &str) -> Result<Option<Arc<ItemView>>> {
    match item(cx, id).await {
        Ok(item) => Ok(item.clone()),
        Err(error) => Err(error.clone()),
    }
}

/// One item, looked up once per request: the page and its shards share the result.
#[memoize]
async fn item(cx: &Cx, id: &str) -> Result<Option<Arc<ItemView>>> {
    let _ = cx;
    if let Some(items) = fixture() {
        return Ok(items.get(id).cloned());
    }
    let base = api_base();
    let mut url = base.clone();
    url.path_segments_mut().map_err(|()| Error::msg(format!("{base} cannot be a base")))?.pop_if_empty().extend([
        "api",
        "discovery",
        "items",
        id,
    ]);
    let client = CLIENT.get_or_init(reqwest::Client::new);
    let res = client.get(url).send().await.map_err(Error::from)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(Error::msg(format!("item API returned {}", res.status())));
    }
    let value: serde_json::Value = res.json().await.map_err(Error::from)?;
    Ok(Some(Arc::new(ItemView::from_api(&value))))
}
