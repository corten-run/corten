//! Locale-neutral catalog records, independent of the marketplace view model.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub description: String,
    pub tags: Vec<String>,
    pub fields: Vec<Field>,
    pub related: Vec<Related>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Related {
    pub id: String,
    pub title: String,
}

impl Record {
    pub fn fields_with_prefix<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = &'a Field> {
        self.fields.iter().filter(move |field| field.name.starts_with(prefix))
    }
}

pub mod source {
    use super::Record;
    use std::{
        collections::HashMap,
        sync::{Arc, OnceLock},
    };

    enum Source {
        Fixture(HashMap<String, Arc<Record>>),
        Api { client: reqwest::Client, base: reqwest::Url },
    }

    static SOURCE: OnceLock<Source> = OnceLock::new();

    pub fn init() {
        source();
    }

    fn source() -> &'static Source {
        SOURCE.get_or_init(|| {
            if std::env::var("CATALOG_SOURCE").as_deref() == Ok("fixture") {
                let path = std::env::var("CATALOG_FIXTURE_PATH").unwrap_or_else(|_| "/fixtures/catalog.json".into());
                let text = std::fs::read_to_string(path).expect("catalog fixture file");
                return Source::Fixture(serde_json::from_str(&text).expect("catalog fixture JSON"));
            }
            let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://localhost:8080".into());
            Source::Api { client: reqwest::Client::new(), base: base.parse().expect("API_BASE is a URL") }
        })
    }

    /// Exactly one fetch and typed parse per call, with no record or response cache.
    pub async fn get(id: &str) -> Result<Option<Arc<Record>>, String> {
        let (client, base) = match source() {
            Source::Fixture(records) => return Ok(records.get(id).cloned()),
            Source::Api { client, base } => (client, base),
        };
        let mut url = base.clone();
        url.path_segments_mut().map_err(|()| "API_BASE cannot be a base URL")?.pop_if_empty().extend(["catalog", "records", id]);
        let response = client.get(url).send().await.map_err(|error| error.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("catalog API returned {}", response.status()));
        }
        response.json::<Record>().await.map(|record| Some(Arc::new(record))).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        serde_json::from_str(r#"{
            "id":"record_1","title":"<trail> & \"notes\"","subtitle":"","description":"001.20",
            "tags":[],"fields":[{"name":"Access","value":"North"},{"name":"access","value":"South"},{"name":" Access","value":"West"},{"name":"Access","value":"East"}],
            "related":[]
        }"#).unwrap()
    }

    #[test]
    fn schema_preserves_strings_and_empty_arrays() {
        let record = record();
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["description"], "001.20");
        assert_eq!(value["tags"], serde_json::json!([]));
        assert_eq!(value["related"], serde_json::json!([]));
        assert_eq!(value.as_object().unwrap().len(), 7);
        assert_eq!(serde_json::from_value::<Record>(value).unwrap(), record);
        assert!(serde_json::from_str::<Record>(r#"{"id":"x","title":"","subtitle":"","description":""}"#).is_err());
    }

    #[test]
    fn prefix_is_case_sensitive_and_not_trimmed() {
        let record = record();
        assert_eq!(record.fields_with_prefix("").count(), 4);
        assert_eq!(record.fields_with_prefix("Ac").map(|f| f.value.as_str()).collect::<Vec<_>>(), ["North", "East"]);
        assert_eq!(record.fields_with_prefix("ac").map(|f| f.value.as_str()).collect::<Vec<_>>(), ["South"]);
        assert_eq!(record.fields_with_prefix(" ").map(|f| f.value.as_str()).collect::<Vec<_>>(), ["West"]);
        assert_eq!(record.fields_with_prefix("missing").count(), 0);
    }
}
