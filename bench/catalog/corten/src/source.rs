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
    /// `base` is parsed once, at startup: a request clones it and adds the record's path.
    Api { client: reqwest::Client, base: Arc<reqwest::Url> },
}

impl Source {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        if std::env::var("CATALOG_SOURCE").as_deref() == Ok("fixture") {
            let path = std::env::var("CATALOG_FIXTURE_PATH").unwrap_or_else(|_| "fixtures/catalog.json".into());
            return Ok(Self::Fixture(Arc::new(serde_json::from_slice(&std::fs::read(path)?)?)));
        }
        Self::api(&std::env::var("API_BASE")?)
    }

    /// The records of the API at `base`, which must be a URL a path can be added to.
    fn api(base: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let base = reqwest::Url::parse(base.trim_end_matches('/'))?;
        if base.cannot_be_a_base() {
            return Err("API_BASE must be hierarchical".into());
        }
        Ok(Self::Api {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(10))
                .build()?,
            base: Arc::new(base),
        })
    }

    pub async fn record(&self, id: &str) -> corten::Result<Option<Arc<Record>>> {
        match self {
            Self::Fixture(records) => Ok(records.get(id).cloned()),
            Self::Api { client, base } => {
                let response = client.get(record_url(base, id)?).send().await?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                let record = corten::json::from_slice(&response.error_for_status()?.bytes().await?)?;
                Ok(Some(Arc::new(record)))
            }
        }
    }
}

/// Where the API at `base` has the record `id`.
fn record_url(base: &reqwest::Url, id: &str) -> corten::Result<reqwest::Url> {
    let mut url = base.clone();
    url.path_segments_mut()
        .map_err(|_| corten::Error::new("API_BASE must be hierarchical"))?
        .pop_if_empty()
        .extend(["catalog", "records", id]);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(of: &str) -> Arc<reqwest::Url> {
        match Source::api(of) {
            Ok(Source::Api { base, .. }) => base,
            _ => panic!("{of} is an API's base"),
        }
    }

    #[test]
    fn a_record_s_url_is_under_the_base_however_the_base_ends() {
        for (of, url) in [
            ("http://127.0.0.1:8080", "http://127.0.0.1:8080/catalog/records/record_1"),
            ("http://127.0.0.1:8080/", "http://127.0.0.1:8080/catalog/records/record_1"),
            ("http://upstream/v1", "http://upstream/v1/catalog/records/record_1"),
            ("http://upstream/v1//", "http://upstream/v1/catalog/records/record_1"),
        ] {
            assert_eq!(record_url(&base(of), "record_1").unwrap().as_str(), url, "{of}");
        }
        // An id is one segment, whatever it holds.
        assert_eq!(record_url(&base("http://upstream"), "a/b?c").unwrap().as_str(), "http://upstream/catalog/records/a%2Fb%3Fc");
    }

    #[test]
    fn a_base_no_path_can_be_added_to_fails_at_startup() {
        assert!(Source::api("mailto:records@example.com").is_err());
        assert!(Source::api("not a url").is_err());
    }
}
