use super::unstaged::unstaged_url;
use super::*;

/// Through an app: a prefetch of a slow page is logged when it is drawn or given up on, and the
/// same page asked for by a click is not.
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn an_app_logs_a_slow_prefetch_and_not_a_slow_click() {
    use std::sync::Arc;
    let routes = Table::new().route(
        "/slow",
        get(|req: Req| async move {
            tokio::time::sleep(Duration::from_millis(650)).await;
            req.page::<ForOne>(html! {
                <html>
                    <head>
                        <title>"Slow"</title>
                        <Corten />
                    </head>
                    <body><main></main></body>
                </html>
            })
        }),
    );
    let router = App::new(Routes::from(routes)).router();
    let ask = |purpose: bool| {
        let mut req = Request::get("/slow").header("corten", "nav");
        if purpose {
            req = req.header("purpose", "prefetch");
        }
        router.clone().oneshot(req.body(Body::empty()).unwrap())
    };
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let text = || String::from_utf8(std::mem::take(&mut *lines.0.lock().unwrap())).unwrap();
    assert!(ask(false).await.unwrap().status().is_success());
    assert!(!text().contains("ahead of a click"));
    assert!(ask(true).await.unwrap().status().is_success());
    let drawn = text();
    assert!(drawn.contains("/slow drew the page ahead of a click"), "{drawn}");
    assert!(tokio::time::timeout(Duration::from_millis(550), ask(true)).await.is_err());
    let dropped = text();
    assert!(dropped.contains("/slow started the page ahead of a click, given up on after"), "{dropped}");
}

/// A panic in an unstaged route's handler is logged with the route's path as written, in every
/// build.
#[cfg(feature = "log")]
#[tokio::test]
async fn an_unstaged_route_s_panic_is_logged_with_its_path() {
    use std::sync::Arc;
    let router = App::new(unstaged_url::router()).router();
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let (status, _, _) = call_with(router, "GET", "/boom", None, None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains("corten: /boom (unstaged) panicked: unstaged and broken"), "{text}");
}

/// A debug build names a hover prefetch that took over half a second, drawn or given up on, and
/// no other.
#[cfg(all(debug_assertions, feature = "log"))]
#[test]
fn a_slow_hover_prefetch_is_logged_in_a_debug_build() {
    use std::sync::Arc;
    let logged = |took: u64, answered: bool| {
        let lines = Lines(Arc::default());
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
        tracing::subscriber::with_default(subscriber, || {
            let mut prefetched = crate::page::Prefetched::new(&"/export?step=pull".parse().unwrap());
            prefetched.began -= Duration::from_millis(took);
            prefetched.answered = answered;
        });
        let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
        text
    };
    let drawn = logged(600, true);
    assert!(drawn.contains("/export?step=pull drew the page ahead of a click"), "{drawn}");
    let dropped = logged(600, false);
    assert!(dropped.contains("given up on after"), "{dropped}");
    assert_eq!(logged(100, true), "");
    assert!(crate::page::is_prefetch(
        &[(http::HeaderName::from_static("purpose"), http::HeaderValue::from_static("prefetch"))].into_iter().collect()
    ));
    assert!(!crate::page::is_prefetch(&http::HeaderMap::new()));
}

/// A failure is logged with each cause under its message (a reset connection under a client's
/// "error sending request"), not its message alone.
#[cfg(all(debug_assertions, feature = "log"))]
#[test]
fn a_failure_is_logged_with_each_cause_under_it() {
    let lines = Lines(std::sync::Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let status = tracing::subscriber::with_default(subscriber, || {
        let reset = Failed("client error (SendRequest)", Some(Box::new(Failed("connection reset", None))));
        Error::new(Failed("error sending request", Some(Box::new(reset)))).into_response().status()
    });
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains("error=error sending request"), "{text}");
    assert!(text.contains("error.sources=[client error (SendRequest), connection reset]"), "{text}");
}

/// A failure with the causes under it, for a test of what is logged.
#[cfg(all(debug_assertions, feature = "log"))]
#[derive(Debug)]
struct Failed(&'static str, Option<Box<dyn std::error::Error + Send + Sync>>);

#[cfg(all(debug_assertions, feature = "log"))]
impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

#[cfg(all(debug_assertions, feature = "log"))]
impl std::error::Error for Failed {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.1.as_deref().map(|source| source as _)
    }
}

/// A streamed download whose chunk fails after the headers is logged as that error, each cause
/// under its message, as a handler's error is; a message (`&str`) is logged as itself (#1153).
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn a_failed_stream_is_logged_with_each_cause_under_it() {
    let lines = Lines(std::sync::Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    // A test runs on one thread, so the stream is pulled, and logs, under this subscriber.
    let _logged = tracing::subscriber::set_default(subscriber);
    let routes = Table::new()
        .route(
            "/error",
            get(|| async {
                let reset = Failed("connection reset", None);
                let failed = Failed("error reading rows", Some(Box::new(reset)));
                let chunks = futures_util::stream::iter([Ok(crate::http::Bytes::from_static(b"a,1\n")), Err(failed)]);
                crate::Media::stream("application/octet-stream", chunks)
            }),
        )
        .route(
            "/message",
            get(|| async {
                let chunks =
                    futures_util::stream::iter([Ok(crate::http::Bytes::from_static(b"a,1\n")), Err("the store went away")]);
                crate::Media::stream("application/octet-stream", chunks)
            }),
        )
        // A stream of `corten::Result`, as one made with the app's own `?` is: logged as the error
        // it holds, causes too.
        .route(
            "/corten",
            get(|| async {
                let gone = Failed("the cursor closed", Some(Box::new(Failed("connection reset", None))));
                let chunks = futures_util::stream::iter([Ok(crate::http::Bytes::from_static(b"a,1\n")), Err(Error::from(gone))]);
                crate::Media::stream("application/octet-stream", chunks)
            }),
        );
    let router = app(routes, None);
    for path in ["/error", "/message", "/corten"] {
        let res = router.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.into_body().collect().await.is_err(), "{path}: the body ends as a failure");
    }
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    let line = |says: &str| text.lines().find(|line| line.contains(says)).unwrap_or_else(|| panic!("{says}: {text}"));
    let error = line("error=error reading rows");
    assert!(error.contains("error.sources=[connection reset]"), "{error}");
    assert!(error.contains("corten: a streamed application/octet-stream answer stopped after its headers were sent"), "{error}");
    let corten = line("error=the cursor closed");
    assert!(corten.contains("error.sources=[connection reset]"), "{corten}");
    let message = line("error=the store went away");
    assert!(!message.contains("error.sources"), "a message has no cause under it: {message}");
}

/// A line written to [`Lines`] ([`log_to`]) starts with its level and holds no time, so a test
/// that looks for a status or a number in what was logged cannot match a time's digits.
#[test]
fn a_line_logged_to_lines_holds_no_time() {
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    tracing::info!("corten: a line with no time");
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(text.trim_start().starts_with("INFO "), "{text}");
    assert!(text.trim_end().ends_with("corten: a line with no time"), "{text}");
    assert!(!text.chars().any(|c| c.is_ascii_digit()), "{text}");
}

/// A line a thread with no subscriber logs first is still logged by a test's thread that logs to
/// [`Lines`] ([`log_to`]): with that test's subscriber alone registered, `tracing` would decide
/// for the whole process, by the first thread's, that the line is wanted by none.
#[test]
fn a_line_another_thread_reached_first_is_still_logged() {
    let lines = Lines(std::sync::Arc::default());
    let _logging = log_to(&lines);
    fn line() {
        tracing::info!("corten: first reached on a thread with no subscriber");
    }
    std::thread::spawn(line).join().unwrap();
    line();
    let text = String::from_utf8(lines.0.lock().unwrap().clone()).unwrap();
    assert!(text.contains("corten: first reached on a thread with no subscriber"), "{text}");
}
