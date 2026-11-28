use serde::Serialize;
use std::{collections::HashMap, sync::Arc, time::Duration};

/// How long a connection to the upstream may sit idle in the pool before a request opens a new
/// one instead. The catalog fixture (`bench/catalog/upstream.mjs`, on Node 26) answers with
/// `Keep-Alive: timeout=5` and closes a connection idle for its 5 s keep-alive timeout plus
/// Node's 1 s buffer. A request written to a pooled connection as the fixture closes it fails in
/// the send (reqwest keeps an idle connection for 90 s unless told otherwise), so the pool drops a
/// connection a second before the shortest time the fixture advertises. It is not a retry: each
/// record is still one upstream GET.
pub const UPSTREAM_IDLE: Duration = Duration::from_secs(4);

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
        Self::api(&std::env::var("API_BASE").map_err(|error| format!("API_BASE: {error}"))?)
    }

    /// The records of the API at `base`, which must be a URL a path can be added to.
    pub fn api(base: &str) -> Result<Self, Box<dyn std::error::Error>> {
        Self::api_pooled(base, Some(UPSTREAM_IDLE))
    }

    /// [`Source::api`] with `idle` as the pool's idle bound. `None` leaves reqwest's default of 90 s,
    /// the policy before #1569, which a test keeps as the control that fails.
    pub(crate) fn api_pooled(base: &str, idle: Option<Duration>) -> Result<Self, Box<dyn std::error::Error>> {
        let base = reqwest::Url::parse(base.trim_end_matches('/')).map_err(|error| format!("API_BASE is not a URL: {error}"))?;
        if base.cannot_be_a_base() {
            return Err(NOT_A_BASE.into());
        }
        let mut client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(10));
        if let Some(idle) = idle {
            client = client.pool_idle_timeout(idle);
        }
        Ok(Self::Api { client: client.build()?, base: Arc::new(base) })
    }

    pub async fn record(&self, id: &str) -> corten::Result<Option<Arc<Record>>> {
        match self {
            Self::Fixture(records) => Ok(records.get(id).cloned()),
            Self::Api { client, base } => {
                let response = client.get(record_url(base, id)?).send().await?;
                if response.status() == reqwest::StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                // Anything else that is not a success is the upstream's failure. A redirect is one:
                // it is not followed, and its body is not read as a record.
                if !response.status().is_success() {
                    return Err(corten::Error::new(format!("catalog API returned {} for record {id}", response.status())));
                }
                let record = corten::json::from_slice(&response.bytes().await?)?;
                Ok(Some(Arc::new(record)))
            }
        }
    }
}

const NOT_A_BASE: &str = "API_BASE must be hierarchical";

/// Where the API at `base` has the record `id`. `url` says adding a path can fail; it cannot for
/// a base [`Source::api`] took, and nothing else in this crate builds a [`Source::Api`].
fn record_url(base: &reqwest::Url, id: &str) -> corten::Result<reqwest::Url> {
    let mut url = base.clone();
    url.path_segments_mut().map_err(|_| corten::Error::new(NOT_A_BASE))?.pop_if_empty().extend(["catalog", "records", id]);
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
            // A query stays after the path it is added to.
            ("http://upstream/v1?key=1", "http://upstream/v1/catalog/records/record_1?key=1"),
        ] {
            assert_eq!(record_url(&base(of), "record_1").unwrap().as_str(), url, "{of}");
        }
    }

    #[test]
    fn an_id_with_a_slash_or_a_query_in_it_stays_one_segment() {
        assert_eq!(record_url(&base("http://upstream"), "a/b?c").unwrap().as_str(), "http://upstream/catalog/records/a%2Fb%3Fc");
    }

    #[test]
    fn a_base_that_is_not_one_fails_at_startup_and_says_which_variable() {
        for of in ["mailto:records@example.com", "not a url", ""] {
            let Err(error) = Source::api(of) else { panic!("{of:?} is no API's base") };
            assert!(error.to_string().contains("API_BASE"), "{of:?}: {error}");
        }
    }

    /// An upstream that gives one answer to each request, on a connection of its own, and says
    /// the request lines it was sent.
    fn upstream(answers: Vec<(&'static str, String, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut asked = Vec::new();
            for (status, headers, body) in answers {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                asked.push(String::from_utf8(head).unwrap().lines().next().unwrap().to_string());
                let length = body.len();
                let answer = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {length}\r\n\
                     connection: close\r\n{headers}\r\n{body}"
                );
                socket.write_all(answer.as_bytes()).unwrap();
            }
            asked
        });
        (at, thread)
    }

    #[tokio::test]
    async fn a_record_is_fetched_once_and_only_a_success_is_read_as_one() {
        let record = r#"{"id":"record_1","title":"One","subtitle":"","description":"","tags":[],"fields":[],"related":[]}"#;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let elsewhere = format!("http://{}/catalog/records/record_1", listener.local_addr().unwrap());
        let (at, thread) = upstream(vec![
            ("200 OK", String::new(), record.into()),
            ("404 Not Found", String::new(), "{}".into()),
            // A redirect whose body is a record, to a place that is listening.
            ("302 Found", format!("location: {elsewhere}\r\n"), record.into()),
            ("503 Service Unavailable", String::new(), record.into()),
        ]);
        let source = Source::api(&at).unwrap();
        assert_eq!(source.record("record_1").await.unwrap().unwrap().title, "One");
        assert!(source.record("missing").await.unwrap().is_none());
        assert!(source.record("moved").await.is_err());
        assert!(source.record("down").await.is_err());
        let asked = tokio::task::spawn_blocking(move || thread.join().unwrap()).await.unwrap();
        let lines = ["record_1", "missing", "moved", "down"].map(|id| format!("GET /catalog/records/{id} HTTP/1.1"));
        assert_eq!(asked, lines);
        // Nothing connected to the redirect's target.
        listener.set_nonblocking(true).unwrap();
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    }
}
