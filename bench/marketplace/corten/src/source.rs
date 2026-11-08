use crate::model::Record;
use std::{collections::HashMap, sync::Arc};

#[derive(Clone)]
pub enum Source {
    Fixture(Arc<HashMap<String, Arc<Record>>>),
    Api { client: reqwest::Client, base: reqwest::Url },
}
impl Source {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        if std::env::var("MARKETPLACE_SOURCE").as_deref() == Ok("fixture") {
            let path = std::env::var("MARKETPLACE_FIXTURE_PATH").unwrap_or_else(|_| "/fixtures/marketplace.json".into());
            return Ok(Self::Fixture(Arc::new(serde_json::from_slice(&std::fs::read(path)?)?)));
        }
        let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://localhost:8080".into());
        Ok(Self::Api {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: base.parse()?,
        })
    }
    pub async fn record(&self, id: &str) -> corten::Result<Option<Arc<Record>>> {
        let (client, base) = match self {
            Self::Fixture(records) => return Ok(records.get(id).cloned()),
            Self::Api { client, base } => (client, base),
        };
        let mut url = base.clone();
        url.path_segments_mut().map_err(|_| corten::Error::new("API_BASE must be hierarchical"))?.pop_if_empty().extend([
            "marketplace",
            "records",
            id,
        ]);
        let response = client.get(url).send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(corten::Error::new(format!("marketplace API returned {}", response.status())));
        }
        let record = corten::json::from_slice(&response.bytes().await?)?;
        Ok(Some(Arc::new(record)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn http_records_are_fetched_once_and_parsed_on_each_request() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let mut paths = Vec::new();
            for index in 0..5 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                paths.push(String::from_utf8(head).unwrap().lines().next().unwrap().to_string());
                let mut record: Record = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
                record.title = format!("Fresh {index}");
                let (status, body) = match index {
                    0 | 1 => ("200 OK", serde_json::to_string_pretty(&record).unwrap()),
                    2 => ("404 Not Found", "{}".into()),
                    3 => ("503 Service Unavailable", "{}".into()),
                    _ => ("200 OK", "{\"title\":\"incomplete\"}".into()),
                };
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            paths
        });
        let source = Source::Api { client: reqwest::Client::new(), base: format!("http://{addr}/root/").parse().unwrap() };
        for index in 0..2 {
            assert_eq!(source.record("id /?").await.unwrap().unwrap().title, format!("Fresh {index}"));
        }
        assert!(source.record("missing").await.unwrap().is_none());
        assert!(source.record("failure").await.is_err());
        assert!(source.record("bad-json").await.is_err());
        let paths = thread.join().unwrap();
        assert_eq!(paths.len(), 5);
        assert_eq!(paths[0], "GET /root/marketplace/records/id%20%2F%3F HTTP/1.1");
        assert_eq!(paths[0], paths[1]);
    }
}
