use serde::Serialize;
use std::{collections::HashMap, sync::Arc};

#[derive(Debug, Serialize, corten::FromJson, corten::ToJson)]
pub struct Field {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, corten::FromJson, corten::ToJson)]
pub struct Related {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize, corten::FromJson, corten::ToJson)]
pub struct Record {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub description: String,
    pub tags: Vec<String>,
    pub fields: Vec<Field>,
    pub related: Vec<Related>,
}

#[derive(Clone)]
pub enum Source {
    Fixture(Arc<HashMap<String, Arc<Record>>>),
    Api { client: reqwest::Client, base: Arc<str> },
}

impl Source {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        if std::env::var("CATALOG_SOURCE").as_deref() == Ok("fixture") {
            let path = std::env::var("CATALOG_FIXTURE_PATH").unwrap_or_else(|_| "fixtures/catalog.json".into());
            return Ok(Self::Fixture(Arc::new(serde_json::from_slice(&std::fs::read(path)?)?)));
        }
        Ok(Self::Api {
            client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build()?,
            base: std::env::var("API_BASE")?.trim_end_matches('/').into(),
        })
    }

    pub async fn record(&self, id: &str) -> corten::Result<Option<Arc<Record>>> {
        match self {
            Self::Fixture(records) => Ok(records.get(id).cloned()),
            Self::Api { client, base } => {
                let mut url = reqwest::Url::parse(base)?;
                url.path_segments_mut()
                    .map_err(|_| corten::Error::new("API_BASE must be hierarchical"))?
                    .pop_if_empty()
                    .extend(["catalog", "records", id]);
                let response = client.get(url).send().await?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                let record = corten::json::from_slice(&response.error_for_status()?.bytes().await?)?;
                Ok(Some(Arc::new(record)))
            }
        }
    }
}
