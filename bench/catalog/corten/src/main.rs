mod source;
mod views;

use corten::prelude::*;
use source::{Record, Source};
use std::sync::Arc;

#[corten::routes(state = source::Source)]
mod routes {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/catalog/{id}", get = show)]
    pub struct Catalog<'a> {
        pub id: &'a str,
        #[route(query)]
        pub query: crate::CatalogQuery,
    }
}

#[corten::routes(api = Root, state = source::Source)]
mod api {
    #[route("/api")]
    pub struct Root;

    #[route("/api/catalog/{id}", get = json)]
    pub struct Record<'a> {
        pub id: &'a str,
    }
}

#[derive(Clone, Default, Route, Fields)]
#[route(query)]
pub struct CatalogQuery {
    pub field: Option<String>,
}

async fn home(req: Req) -> HtmlResult {
    req.page(views::document(
        &req,
        "Catalog",
        html! {
            <h1>"Catalog"</h1>
            <a href={routes::Catalog { id: "record_1", query: CatalogQuery::default() }}>"Open a record"</a>
        },
    ))
}

async fn show(req: Req, State(source): State<Source>, Params(at): Params<routes::Catalog<'_>>) -> HtmlResult {
    let record = source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?;
    req.page(views::document(&req, &record.title, views::record(&record, at.query.field.as_deref().unwrap_or(""))))
}

async fn json(State(source): State<Source>, Params(at): Params<api::Record<'_>>) -> JsonResult<Arc<Record>> {
    Ok(Json(source.record(&at.id).await?.ok_or_else(corten::Error::not_found)?))
}

fn app(source: Source, lean: bool) -> App {
    let app = App::new(routes::router(source.clone()))
        .api(|routes| api::api(routes, source))
        .assets(views::Static)
        .components(&[views::SiteHeader]);
    if lean {
        app.deadline(None).header_timeout(None).send_timeout(None)
    } else {
        app
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let source = Source::from_env().map_err(|error| std::io::Error::other(error.to_string()))?;
    let lean = std::env::var("PROFILE").as_deref() == Ok("catalog-lean");
    corten::serve(app(source, lean)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use corten::http::StatusCode;
    use serde_json::json;

    fn application() -> corten::testing::Client {
        application_with_profile(false)
    }

    fn application_with_profile(lean: bool) -> corten::testing::Client {
        let record = json!({
            "id": "record_1", "title": "Trail <script> & friends", "subtitle": "Notes",
            "description": "<img src=x onerror=alert(1)>", "tags": ["a&b"],
            "fields": [{"name":"Access","value":"North"},{"name":"access","value":"South"}],
            "related": [{"id":"record_2","title":"Other <trail>"}]
        });
        let data = serde_json::from_value(json!({"record_1": record})).unwrap();
        app(Source::Fixture(Arc::new(data)), lean).test()
    }

    #[tokio::test]
    async fn lean_and_default_profiles_keep_page_and_json_contracts() {
        for lean in [false, true] {
            let app = application_with_profile(lean);
            let page = app.get(&routes::Catalog { id: "record_1", query: CatalogQuery::default() }).await;
            assert_eq!(page.status(), StatusCode::OK);
            assert!(page.text().contains("Trail &lt;script&gt; &amp; friends"));
            assert!(page.headers().contains_key("content-security-policy"));
            assert_eq!(page.headers()["x-content-type-options"], "nosniff");
            assert_eq!(app.get(&api::Record { id: "record_1" }).await.status(), StatusCode::OK);
            assert_eq!(app.get(&api::Record { id: "missing" }).await.status(), StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn renders_all_fields_and_escapes_text() {
        let answer = application().get(&routes::Catalog { id: "record_1", query: CatalogQuery::default() }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        let html = answer.text();
        assert!(html.contains("Trail &lt;script&gt; &amp; friends"));
        assert!(!html.contains("<img src=x"));
        assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;"));
        assert!(html.contains("<th scope=\"row\">Access</th>"));
        assert!(html.contains("<th scope=\"row\">access</th>"));
        assert!(html.contains("href=\"/catalog/record_2\""));
        assert!(answer.headers().contains_key("content-security-policy"));
        assert_eq!(answer.headers()["x-content-type-options"], "nosniff");
    }

    #[tokio::test]
    async fn prefix_is_case_sensitive_and_retained() {
        let answer =
            application().get(&routes::Catalog { id: "record_1", query: CatalogQuery { field: Some("A".into()) } }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        assert!(answer.text().contains("value=\"A\""));
        assert!(answer.text().contains("<th scope=\"row\">Access</th>"));
        assert!(!answer.text().contains("<th scope=\"row\">access</th>"));
    }

    #[tokio::test]
    async fn json_keeps_strings_and_missing_records_are_404() {
        let app = application();
        let answer = app.get(&api::Record { id: "record_1" }).await;
        assert_eq!(answer.status(), StatusCode::OK);
        let record: serde_json::Value = serde_json::from_str(answer.text()).unwrap();
        assert_eq!(record["title"], "Trail <script> & friends");
        assert_eq!(record["fields"].as_array().unwrap().len(), 2);
        assert_eq!(app.get(&api::Record { id: "missing" }).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            app.get(&routes::Catalog { id: "missing", query: CatalogQuery::default() }).await.status(),
            StatusCode::NOT_FOUND
        );
    }

    /// How long the catalog fixture (`bench/catalog/upstream.mjs`, Node's HTTP server) says it
    /// keeps an idle connection open: it answers with `Keep-Alive: timeout=5`.
    const FIXTURE_KEEP_ALIVE: std::time::Duration = std::time::Duration::from_secs(5);

    /// What the upstream did, in milliseconds from its start, on which of its connections.
    #[derive(Clone, Debug, PartialEq)]
    enum Seen {
        Accepted,
        Answered(String),
        /// A request arrived on a connection idle this long, and the connection closed unanswered.
        ClosedIdle(u128),
        ClosedByClient,
    }

    type Log = Arc<std::sync::Mutex<Vec<(u128, usize, Seen)>>>;

    /// The fixture's idle close, made deterministic. The fixture closes a connection that has been
    /// idle for its keep-alive timeout; a request written to it in that instant never reaches its
    /// handler. Here every request that arrives on a connection idle for at least
    /// [`FIXTURE_KEEP_ALIVE`] meets that close: the connection is dropped with the request unread,
    /// which resets it, and nothing answers. A request on a fresh or recently used connection is
    /// answered with `body`, and the connection kept open. Each answer is logged before it is
    /// written, and [`ClosingUpstream::stop`] joins every thread before the log is read, so the log
    /// is complete when the test inspects it. Dropping it (also when a test fails early) stops and
    /// joins every thread as well.
    struct ClosingUpstream {
        at: String,
        started: std::time::Instant,
        stopping: Arc<std::sync::atomic::AtomicBool>,
        accepting: Option<std::thread::JoinHandle<()>>,
        seen: Log,
    }

    impl ClosingUpstream {
        fn start(body: &'static str) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let at = format!("http://{}", listener.local_addr().unwrap());
            let (started, seen, stopping) =
                (std::time::Instant::now(), Log::default(), Arc::<std::sync::atomic::AtomicBool>::default());
            let (log, stop) = (seen.clone(), stopping.clone());
            let accepting = std::thread::spawn(move || {
                let (mut connections, mut failure) = (Vec::new(), None);
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            let (log, stop, connection) = (log.clone(), stop.clone(), connections.len());
                            connections.push(std::thread::spawn(move || serve(socket, connection, body, started, &log, &stop)));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5))
                        }
                        Err(error) => {
                            failure = Some(format!("accept: {error}"));
                            stop.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
                let panicked = connections.into_iter().map(std::thread::JoinHandle::join).filter(Result::is_err).count();
                assert!(failure.is_none() && panicked == 0, "{failure:?}; {panicked} connection threads panicked");
            });
            Self { at, started, stopping, accepting: Some(accepting), seen }
        }

        fn now(&self) -> u128 {
            self.started.elapsed().as_millis()
        }

        /// Stops accepting and waits for every thread to end: each connection's thread checks within
        /// [`POLL`] while it waits for a request, and a write gives up after [`WRITE`].
        fn halt(&mut self) -> std::thread::Result<()> {
            self.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
            self.accepting.take().map_or(Ok(()), std::thread::JoinHandle::join)
        }

        /// Stops, then returns everything the upstream did.
        fn stop(mut self) -> Vec<(u128, usize, Seen)> {
            self.halt().expect("an upstream thread panicked");
            self.seen.lock().unwrap().clone()
        }
    }

    impl Drop for ClosingUpstream {
        fn drop(&mut self) {
            // A panic here while a failed test unwinds would abort; that failure is already reported.
            if self.halt().is_err() && !std::thread::panicking() {
                panic!("an upstream thread panicked");
            }
        }
    }

    /// How often a connection's thread, waiting for a request, checks whether the upstream is stopping.
    const POLL: std::time::Duration = std::time::Duration::from_millis(20);
    /// How long a connection's thread waits to write an answer before it gives up.
    const WRITE: std::time::Duration = std::time::Duration::from_secs(2);

    /// The connections that answered a `line` request.
    fn connections(seen: &[(u128, usize, Seen)], line: &str) -> Vec<usize> {
        let answered = Seen::Answered(line.into());
        let mut found: Vec<usize> = seen.iter().filter_map(|(_, c, s)| (*s == answered).then_some(*c)).collect();
        found.sort_unstable();
        found.dedup();
        found
    }

    /// The idle closes logged at or after `from` ms.
    fn closed_since(seen: &[(u128, usize, Seen)], from: u128) -> usize {
        seen.iter().filter(|(at, _, s)| matches!(s, Seen::ClosedIdle(_)) && *at >= from).count()
    }

    fn serve(
        mut socket: std::net::TcpStream,
        connection: usize,
        body: &str,
        started: std::time::Instant,
        log: &std::sync::Mutex<Vec<(u128, usize, Seen)>>,
        stopping: &std::sync::atomic::AtomicBool,
    ) {
        use std::io::{ErrorKind, Read, Write};
        let record = |seen| log.lock().unwrap().push((started.elapsed().as_millis(), connection, seen));
        let waiting = |error: &std::io::Error| matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut);
        let stopped = || stopping.load(std::sync::atomic::Ordering::SeqCst);
        record(Seen::Accepted);
        socket.set_nonblocking(false).unwrap();
        socket.set_read_timeout(Some(POLL)).unwrap();
        socket.set_write_timeout(Some(WRITE)).unwrap();
        let mut answered: Option<std::time::Instant> = None;
        loop {
            match socket.peek(&mut [0]) {
                Ok(1) => {}
                Err(error) if waiting(&error) && !stopped() => continue,
                Err(error) if waiting(&error) => return,
                _ => return record(Seen::ClosedByClient),
            }
            if let Some(idle) = answered.map(|at| at.elapsed()).filter(|idle| *idle >= FIXTURE_KEEP_ALIVE) {
                return record(Seen::ClosedIdle(idle.as_millis()));
            }
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                match socket.read(&mut byte) {
                    Ok(1) => head.push(byte[0]),
                    Err(error) if waiting(&error) && !stopped() => {}
                    Err(error) if waiting(&error) => return,
                    other => panic!("the request head ended early: {other:?}"),
                }
            }
            let line = String::from_utf8(head).unwrap().lines().next().unwrap().to_string();
            let length = body.len();
            record(Seen::Answered(line));
            write!(socket, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {length}\r\nkeep-alive: timeout=5\r\n\r\n{body}")
                .unwrap();
            answered = Some(std::time::Instant::now());
        }
    }

    /// A page whose upstream connection sat idle past the fixture's keep-alive is answered from a
    /// new connection with one upstream request, not failed with a 500 (#1569). The control is the
    /// same page through the same handler with the pool policy before that change (reqwest's
    /// default of 90 s): it reuses the connection the upstream closed, and the page fails.
    #[tokio::test]
    async fn a_page_after_the_upstream_s_keep_alive_does_not_reuse_its_closed_connection() {
        const RECORD: &str =
            r#"{"id":"record_1","title":"One","subtitle":"","description":"","tags":[],"fields":[],"related":[]}"#;
        assert!(source::UPSTREAM_IDLE < FIXTURE_KEEP_ALIVE);
        let (fixed_upstream, old_upstream) = (ClosingUpstream::start(RECORD), ClosingUpstream::start(RECORD));
        let fixed = app(Source::api(&fixed_upstream.at).unwrap(), true).test();
        let old = app(Source::api_pooled(&old_upstream.at, None).unwrap(), true).test();
        let page = routes::Catalog { id: "record_1", query: CatalogQuery::default() };
        assert_eq!(fixed.get(&page).await.status(), StatusCode::OK);
        assert_eq!(old.get(&page).await.status(), StatusCode::OK);
        tokio::time::sleep(FIXTURE_KEEP_ALIVE + std::time::Duration::from_millis(250)).await;
        let sent = (fixed_upstream.now(), old_upstream.now());
        let (answer, failed) = (fixed.get(&page).await.status(), old.get(&page).await.status());
        let (seen, old_seen, line) = (fixed_upstream.stop(), old_upstream.stop(), "GET /catalog/records/record_1 HTTP/1.1");
        assert_eq!(failed, StatusCode::INTERNAL_SERVER_ERROR, "old policy, sent at {} ms: {old_seen:?}", sent.1);
        assert_eq!((closed_since(&old_seen, sent.1), connections(&old_seen, line).len()), (1, 1), "{old_seen:?}");
        assert_eq!(answer, StatusCode::OK, "sent at {} ms; upstream: {seen:?}", sent.0);
        assert_eq!(closed_since(&seen, sent.0), 0, "{seen:?}");
        let answers = seen.iter().filter(|(_, _, s)| *s == Seen::Answered(line.into())).count();
        assert_eq!(
            (answers, connections(&seen, line).len()),
            (2, 2),
            "one upstream request per page, on a new connection: {seen:?}"
        );
    }
}
