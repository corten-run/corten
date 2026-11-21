use super::*;

#[tokio::test]
async fn a_live_stream_that_finishes_tells_the_element_to_stop() {
    let router = Table::new()
        .route("/", get(|| async { crate::live(futures_util::stream::iter([String::from(r#"<p id="late">Ready</p>"#)])) }));
    let (status, headers, body) = call(router, "GET", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "text/event-stream");
    assert_eq!(headers["x-accel-buffering"], "no", "nginx passes each patch on as it is written");
    assert_eq!(body, "event: patch\ndata: <p id=\"late\">Ready</p>\n\nevent: end\ndata: end\n\n");
}

/// `live_watch` sends the current value only to a page that is behind, then each change, and
/// ends when the value's sender goes.
#[tokio::test]
async fn a_live_watch_sends_the_latest_value_from_where_the_page_is() {
    use crate::LiveSince;
    let (tx, rx) = tokio::sync::watch::channel(7u64);
    let stream = |since: Option<&str>| {
        let since = LiveSince(since.map(str::to_string));
        crate::live_watch(rx.clone(), since, |n| n.to_string(), |n| format!(r#"<p id="n">{n}</p>"#))
    };
    let (behind, current) = (stream(Some("6")), stream(Some("7")));
    let first = stream(None);
    tx.send_replace(8);
    tx.send_replace(9); // the browser only needs the latest: 8 is skipped
    drop(tx);
    let body = |res: LiveResponse| async move {
        String::from_utf8(res.into_response().into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    };
    let nine = "event: patch\nid: 9\ndata: <p id=\"n\">9</p>\n\nevent: end\ndata: end\n\n";
    assert_eq!(body(current).await, nine, "a page showing 7 gets the next change");
    assert_eq!(body(behind).await, nine, "a page behind gets the latest");
    assert_eq!(body(first).await, nine);
    let (tx, rx) = tokio::sync::watch::channel(7u64);
    let behind = crate::live_watch(rx, LiveSince(Some("6".into())), |n| n.to_string(), |n| format!(r#"<p id="n">{n}</p>"#));
    let read = tokio::spawn(body(behind));
    tokio::task::yield_now().await;
    drop(tx);
    assert_eq!(
        read.await.unwrap(),
        "event: patch\nid: 7\ndata: <p id=\"n\">7</p>\n\nevent: end\ndata: end\n\n",
        "the current one first"
    );

    // A receiver kept in the app's state never reads, so a clone of it has not seen 8: a page
    // showing 8 still gets nothing until the next change.
    let (tx, kept) = tokio::sync::watch::channel(7u64);
    tx.send_replace(8);
    let current = crate::live_watch(kept.clone(), LiveSince(Some("8".into())), |n| *n, |n| format!(r#"<p id="n">{n}</p>"#));
    drop(tx);
    assert_eq!(body(current).await, "event: end\ndata: end\n\n", "nothing to send");
}

/// What a change costs `live_watch` with many pages open: `WATCH_STREAMS` (300) streams of a
/// table of 50 rows (3,132 bytes) and `WATCH_CHANGES` (200) changes, each sent once every stream
/// has the one before. The channel holds what the live data guide advises, the cursor, the rows in
/// an `Arc` and their HTML, and each page's view renders the rows or copies the HTML out. Prints
/// the median and slowest time from a change to the last stream having it. `WATCH_ROUNDS` (3)
/// rounds of `WATCH_MODE` (`per-stream`, `once`, or both when unset); counting one mode at two
/// numbers of changes under callgrind gives its instructions per change. Run in release:
/// `cargo test --release -p corten-run --lib -- --ignored --nocapture what_a_change_costs_live_watch`
#[test]
#[ignore]
fn what_a_change_costs_live_watch() {
    use crate::LiveSince;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    struct Row {
        name: String,
        price: u64,
        change: i64,
    }
    fn rows(version: u64) -> Vec<Row> {
        (0..50)
            .map(|n| Row { name: format!("Stock {n}"), price: 1_000 + version * 7 + n, change: (version as i64 % 9) - 4 })
            .collect()
    }
    fn table(rows: &[Row]) -> String {
        html! {
            <table id="quotes">
                <tbody>
                    for row in rows {
                        <tr>
                            <th scope="row">{&row.name}</th>
                            <td>{row.price}</td>
                            <td>{row.change}</td>
                        </tr>
                    }
                </tbody>
            </table>
        }
        .to_html()
    }
    type Quotes = (u64, Arc<Vec<Row>>, Arc<str>);
    let var = |name: &str, or: usize| std::env::var(name).ok().and_then(|n| n.parse().ok()).unwrap_or(or);
    let (streams, changes) = (var("WATCH_STREAMS", 300), var("WATCH_CHANGES", 200));
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let mode = std::env::var("WATCH_MODE").unwrap_or_default();
    let modes: Vec<bool> = [false, true].into_iter().filter(|once| mode.is_empty() || (mode == "once") == *once).collect();
    for round in 1..=var("WATCH_ROUNDS", 3) {
        for once in modes.iter().copied() {
            let (times, renders) = runtime.block_on(async {
                let renders = Arc::new(AtomicUsize::new(0));
                // The task that changes the quotes; rendered once, it renders them too.
                let quotes = |version: u64| -> Quotes {
                    let rows = Arc::new(rows(version));
                    let html = if once { Arc::from(table(&rows)) } else { Arc::from("") };
                    (version, rows, html)
                };
                let (tx, rx) = tokio::sync::watch::channel(quotes(0));
                // Each stream says when it has a change, so waiting for them costs nothing.
                let (got, mut arrived) = tokio::sync::mpsc::unbounded_channel::<()>();
                let mut readers = Vec::new();
                for _ in 0..streams {
                    let renders = renders.clone();
                    let since = LiveSince(Some("0".into()));
                    let res = if once {
                        crate::live_watch(rx.clone(), since, |(v, _, _): &Quotes| *v, |(_, _, html): &Quotes| html.to_string())
                    } else {
                        crate::live_watch(
                            rx.clone(),
                            since,
                            |(v, _, _): &Quotes| *v,
                            move |(_, rows, _): &Quotes| {
                                renders.fetch_add(1, Ordering::Relaxed);
                                table(rows)
                            },
                        )
                    };
                    let got = got.clone();
                    readers.push(tokio::spawn(async move {
                        let mut body = res.into_response().into_body();
                        while let Some(Ok(frame)) = body.frame().await {
                            // One event a frame: its first bytes say which.
                            if frame.data_ref().is_some_and(|data| data.starts_with(b"event: patch")) {
                                let _ = got.send(());
                            }
                        }
                    }));
                }
                let mut times = Vec::with_capacity(changes);
                for version in 1..=changes as u64 {
                    let started = std::time::Instant::now();
                    tx.send_replace(quotes(version));
                    for _ in 0..streams {
                        arrived.recv().await.unwrap();
                    }
                    times.push(started.elapsed());
                }
                drop((tx, got));
                for reader in readers {
                    reader.await.unwrap();
                }
                times.sort();
                (times, renders.load(Ordering::Relaxed))
            });
            // Rendered once: the first and one a change, by the task.
            let renders = if once { changes + 1 } else { renders };
            println!(
                "round {round}, {}: {streams} streams, {changes} changes, {renders} renders: a change reached every stream in {:?} at the median, {:?} at the slowest",
                if once { "rendered once" } else { "rendered per stream" },
                times[times.len() / 2],
                times[times.len() - 1]
            );
        }
    }
}

#[tokio::test]
async fn a_live_fragment_carries_its_cursor_and_a_reconnect_reads_it_back() {
    use crate::{Fragment, LiveSince};
    let fragments = || {
        futures_util::stream::iter([
            Fragment::new(r#"<p id="n">7</p>"#.into()).cursor("v7"),
            Fragment::new(r#"<p id="n">8</p>"#.into()),
        ])
    };
    let router = Table::new().route("/", get(move || async move { crate::live(fragments()) }));
    let (_, _, body) = call(router, "GET", None).await;
    // The id carries over in the browser to a fragment that has none, as SSE defines.
    assert_eq!(
        body,
        "event: patch\nid: v7\ndata: <p id=\"n\">7</p>\n\nevent: patch\ndata: <p id=\"n\">8</p>\n\nevent: end\ndata: end\n\n"
    );

    let since = |uri: &str, header: Option<&str>| {
        let mut req = Request::builder().uri(uri);
        if let Some(header) = header {
            req = req.header("last-event-id", header);
        }
        let (mut parts, ()) = req.body(()).unwrap().into_parts();
        async move { <LiveSince as crate::extract::FromRequestParts<()>>::from_request_parts(&mut parts, &()).await.unwrap().0 }
    };
    assert_eq!(since("/live", None).await, None, "a first connection without since");
    assert_eq!(since("/live?since=a%20b&x=1", None).await.as_deref(), Some("a b"), "the page's cursor");
    assert_eq!(since("/live?since=page", Some("v9")).await.as_deref(), Some("v9"), "a reconnect's cursor wins");
    assert_eq!(since("/live?since=page", Some("")).await.as_deref(), Some("page"), "an empty Last-Event-ID is none");
}

#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "line break")]
fn a_cursor_cannot_end_its_event() {
    let _ = crate::Fragment::new(String::new()).cursor("a\nevent: patch");
}

#[test]
#[cfg(not(debug_assertions))]
fn a_cursor_that_would_end_its_event_is_left_off_in_release() {
    assert_eq!(crate::Fragment::new(String::new()).cursor("a\nevent: patch").cursor, None);
}

#[cfg(debug_assertions)]
#[tokio::test]
#[should_panic(
    expected = "the browser would lose part of a live fragment: <tr id=\"b\"> is dropped, since <p id=\"a\"> comes first"
)]
async fn a_live_fragment_the_browser_would_lose_part_of_panics_in_debug_builds() {
    let fragment = || String::from(r#"<p id="a">1</p><tr id="b"><td>2</td></tr>"#);
    let router = Table::new().route("/", get(move || async move { crate::live(futures_util::stream::iter([fragment()])) }));
    let _ = call(router, "GET", None).await;
}

/// A CDATA section in an SVG `<title>`, an HTML integration point, is the title's text, as it is
/// in any element of an `<svg>`: the id check reads past it to the id-less `<p>` after the
/// drawing, which the browser drops (#1409).
#[cfg(debug_assertions)]
#[tokio::test]
#[should_panic(expected = "a live fragment's top-level <p> has no id")]
async fn a_live_fragment_s_element_after_cdata_in_an_svg_title_is_checked_for_its_id() {
    let fragment = || String::from(r#"<svg id="s"><title><![CDATA[x]]></title></svg><p>lost</p>"#);
    let router = Table::new().route("/", get(move || async move { crate::live(futures_util::stream::iter([fragment()])) }));
    let _ = call(router, "GET", None).await;
}

#[cfg(debug_assertions)]
#[tokio::test]
#[should_panic(expected = "top-level text \"saved\" outside an element")]
async fn a_live_fragment_the_browser_would_drop_panics_in_debug_builds() {
    let router = Table::new().route("/", get(|| async { crate::live(futures_util::stream::iter([String::from("saved")])) }));
    let _ = call(router, "GET", None).await;
}

#[cfg(all(debug_assertions, feature = "log"))]
#[derive(crate::view::Id)]
struct LiveFormId;

/// A live fragment is text, rendered after the stream's headers went out, so a form's new submit
/// key in one cannot make the stream private as it makes a page: under `corten dev` a stream marked
/// for shared caches whose fragment draws one is logged, and one left with its own caching, or
/// whose fragments draw no key, is not.
#[cfg(all(debug_assertions, feature = "log"))]
#[tokio::test]
async fn a_shared_live_stream_that_draws_a_submit_key_is_logged_under_corten_dev() {
    use std::sync::Arc;
    let minute = std::time::Duration::from_secs(60);
    let form = |keyed: bool| {
        futures_util::stream::once(async move {
            html! { <form id={LiveFormId} method="post">if keyed { {crate::SubmitKey::field(KeyedWrite::FIELDS.submit)} }</form> }
                .to_html()
        })
    };
    let routes = Table::new()
        .route("/shared", get(move || async move { Public::new(minute, crate::live(form(true))) }))
        .route("/own", get(move || async move { crate::live(form(true)) }))
        .route("/plain", get(move || async move { Public::new(minute, crate::live(form(false))) }));
    let lines = Lines(Arc::default());
    let writer = lines.clone();
    let subscriber = tracing_subscriber::fmt().with_ansi(false).with_writer(move || writer.clone()).finish();
    let _logging = tracing::subscriber::set_default(subscriber);
    let router = App::new(Routes::from(routes)).dev(true).router();
    let logged = |uri: &'static str| {
        let (router, lines) = (router.clone(), lines.clone());
        async move {
            lines.0.lock().unwrap().clear();
            let res = router.oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
            let cache = res.headers()[header::CACHE_CONTROL].to_str().unwrap().to_string();
            let body = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
            assert!(body.starts_with("event: patch\ndata: <form id="), "{body}");
            (cache, String::from_utf8(lines.0.lock().unwrap().clone()).unwrap())
        }
    };
    let (cache, text) = logged("/shared").await;
    assert_eq!(cache, "public, max-age=60", "its headers went out before the fragment was drawn");
    assert!(
        text.contains("corten: /shared is marked for shared caches, but a live fragment draws a form's new submit key"),
        "{text}"
    );
    let (cache, text) = logged("/own").await;
    assert_eq!(cache, "no-cache");
    assert!(!text.contains("submit key"), "{text}");
    let (_, text) = logged("/plain").await;
    assert!(!text.contains("submit key"), "{text}");
}
