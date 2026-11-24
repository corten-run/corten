use crate::model::Record;
use std::{collections::HashMap, sync::Arc, time::Duration};

/// How long a connection to the upstream may sit idle in the pool before a request opens a new
/// one instead. The marketplace fixture (`bench/marketplace/upstream.mjs`, on Node 26) answers
/// with `Keep-Alive: timeout=5` and closes a connection idle for its 5 s keep-alive timeout plus
/// Node's 1 s buffer. A request written to a pooled connection as the fixture closes it fails in
/// the send (reqwest keeps an idle connection for 90 s unless told otherwise), so the pool drops a
/// connection a second before the shortest time the fixture advertises. It is not a retry: each
/// record is still one upstream GET.
pub const UPSTREAM_IDLE: Duration = Duration::from_secs(4);

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
        Self::api(&base)
    }

    /// The records of the API at `base`.
    pub fn api(base: &str) -> Result<Self, Box<dyn std::error::Error>> {
        Self::api_pooled(base, Some(UPSTREAM_IDLE))
    }

    /// [`Source::api`] with `idle` as the pool's idle bound. `None` leaves reqwest's default of 90 s,
    /// the policy before #1893, which a test keeps as the control that fails.
    pub(crate) fn api_pooled(base: &str, idle: Option<Duration>) -> Result<Self, Box<dyn std::error::Error>> {
        let mut client = reqwest::Client::builder().timeout(Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none());
        if let Some(idle) = idle {
            client = client.pool_idle_timeout(idle);
        }
        Ok(Self::Api { client: client.build()?, base: base.parse()? })
    }
    pub async fn record(&self, id: &str, traceparent: Option<&str>) -> corten::Result<Option<Arc<Record>>> {
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
        let mut request = client.get(url);
        if let Some(parent) = crate::trace::parent(traceparent) {
            request = request.header("traceparent", parent);
        }
        let response = request.send().await.map_err(upstream_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(corten::Error::new(format!("marketplace API returned {}", response.status())));
        }
        let record = corten::json::from_slice(&response.bytes().await.map_err(upstream_error)?)?;
        Ok(Some(Arc::new(record)))
    }
}

fn upstream_error(error: reqwest::Error) -> corten::Error {
    let status = if error.is_timeout() {
        corten::http::StatusCode::GATEWAY_TIMEOUT
    } else {
        corten::http::StatusCode::INTERNAL_SERVER_ERROR
    };
    corten::Error::new(error).with_status(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn whole_read_timeouts_are_gateway_timeouts_and_close_the_source() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            time::Duration,
        };
        for body in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let thread = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                if body {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{\"id\":")
                        .unwrap();
                }
                let mut byte = [0];
                assert_eq!(socket.read(&mut byte).unwrap(), 0, "timed-out upstream was not closed");
            });
            let source = Source::Api {
                client: reqwest::Client::builder().timeout(Duration::from_millis(200)).build().unwrap(),
                base: format!("http://{addr}").parse().unwrap(),
            };
            let error = source.record("item_1", None).await.unwrap_err();
            assert_eq!(error.status_code(), corten::http::StatusCode::GATEWAY_TIMEOUT);
            tokio::task::spawn_blocking(move || thread.join().unwrap()).await.unwrap();
        }
    }

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
            for (index, parent) in [
                Some("00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bbbbbbbbbbbbbbbb-00"),
                Some("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-00"),
                None,
                None,
                None,
            ]
            .into_iter()
            .enumerate()
            {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                let head = String::from_utf8(head).unwrap();
                let actual = head.lines().find_map(|line| line.strip_prefix("traceparent: "));
                assert_eq!(actual, parent);
                paths.push(head.lines().next().unwrap().to_string());
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
        // The first future is not polled until another request's distinct context completes.
        let delayed = source.record("id /?", Some("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa-00"));
        let current = source.record("id /?", Some("00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bbbbbbbbbbbbbbbb-00"));
        assert_eq!(current.await.unwrap().unwrap().title, "Fresh 0");
        assert_eq!(delayed.await.unwrap().unwrap().title, "Fresh 1");
        assert!(source.record("missing", None).await.unwrap().is_none());
        assert!(source.record("failure", None).await.is_err());
        assert!(source.record("bad-json", None).await.is_err());
        let paths = thread.join().unwrap();
        assert_eq!(paths.len(), 5);
        assert_eq!(paths[0], "GET /root/marketplace/records/id%20%2F%3F HTTP/1.1");
        assert_eq!(paths[0], paths[1]);
    }
}
