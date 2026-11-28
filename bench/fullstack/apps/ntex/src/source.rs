use serde::de::DeserializeOwned;
use std::{collections::HashMap, sync::Arc, time::Duration};

pub enum Source<T> {
    Fixture(HashMap<String, Arc<T>>),
    Api(reqwest::Client, reqwest::Url, &'static str),
}

impl<T: DeserializeOwned> Source<T> {
    pub fn load(name: &'static str) -> Self {
        let key = name.to_ascii_uppercase();
        if std::env::var(format!("{key}_SOURCE")).as_deref() == Ok("fixture") {
            let path = std::env::var(format!("{key}_FIXTURE_PATH")).unwrap_or_else(|_| format!("/fixtures/{name}.json"));
            return Self::Fixture(serde_json::from_slice(&std::fs::read(path).expect("fixture file")).expect("typed fixture"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(4))
            .build()
            .expect("HTTP client");
        let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://localhost:8080".into()).parse().expect("upstream URL");
        Self::Api(client, base, name)
    }

    pub async fn get(&self, id: &str) -> Result<Option<Arc<T>>, Box<dyn std::error::Error>> {
        match self {
            Self::Fixture(records) => Ok(records.get(id).cloned()),
            Self::Api(client, base, name) => {
                let mut url = base.clone();
                url.path_segments_mut().expect("hierarchical upstream URL").pop_if_empty().extend([*name, "records", id]);
                let reply = client.get(url).send().await?;
                if reply.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                if !reply.status().is_success() {
                    return Err(format!("upstream returned {}", reply.status()).into());
                }
                Ok(Some(Arc::new(reply.json::<T>().await?)))
            }
        }
    }
}
