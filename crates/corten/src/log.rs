//! The subscriber [`crate::serve`] installs when the app has set none (feature `log`): each
//! event at `INFO` or above as one line on stdout, as `tracing-subscriber`'s `fmt()` without
//! targets writes it (`2026-11-06T21:20:29.018154Z  WARN message key=value`), so errors,
//! startup and shutdown print without that crate and the four only it needs. Spans are off, so an
//! event prints without the spans it is in: an app that wants them, a filter or JSON lines sets a
//! subscriber of its own (`tracing-subscriber`) before `serve`, which then leaves it alone.
//! Control characters other than a tab are escaped wherever they are, so text a request sent
//! cannot recolor the terminal or start a line of its own. Colors are `tracing-subscriber`'s,
//! when stdout is a terminal and `NO_COLOR` is unset.

use std::{
    fmt::{self, Write as _},
    io::{IsTerminal, Write as _},
    time::{SystemTime, UNIX_EPOCH},
};

use tracing::{
    field::{Field, Visit},
    level_filters::LevelFilter,
    span::{Attributes, Id, Record},
    subscriber::{Interest, Subscriber},
    Event, Level, Metadata,
};

/// Installs [`Stdout`] as the global subscriber unless one is set already.
pub(crate) fn init() {
    let color = colors(std::io::stdout().is_terminal(), std::env::var_os("NO_COLOR"));
    let write = Box::new(|line: &[u8]| {
        let _ = std::io::stdout().lock().write_all(line);
    });
    let _ = tracing::subscriber::set_global_default(Stdout { color, write });
}

/// Colors only on a terminal, and not when `NO_COLOR` is set to anything but an empty string
/// (no-color.org's rule, and `tracing-subscriber`'s).
fn colors(terminal: bool, no_color: Option<std::ffi::OsString>) -> bool {
    terminal && no_color.is_none_or(|v| v.is_empty())
}

/// Where each line goes, in one write so lines from several threads do not interleave.
type Sink = Box<dyn Fn(&[u8]) + Send + Sync>;

pub(crate) struct Stdout {
    color: bool,
    write: Sink,
}

fn wanted(meta: &Metadata<'_>) -> bool {
    meta.is_event() && *meta.level() <= Level::INFO
}

impl Subscriber for Stdout {
    fn register_callsite(&self, meta: &'static Metadata<'static>) -> Interest {
        if wanted(meta) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn enabled(&self, meta: &Metadata<'_>) -> bool {
        wanted(meta)
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        Some(LevelFilter::INFO)
    }

    // A span is never enabled, so nothing records into one; an id is still a valid answer for a
    // span made directly.
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}

    fn record_follows_from(&self, _: &Id, _: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut line = String::with_capacity(128);
        let style = Style(self.color);
        style.paint(&mut line, DIM, |out| timestamp(out, SystemTime::now()));
        line.push(' ');
        level(&mut line, event.metadata().level(), style);
        line.push(' ');
        event.record(&mut Fields { line: &mut line, first: true, style });
        line.push('\n');
        (self.write)(line.as_bytes());
    }

    fn enter(&self, _: &Id) {}

    fn exit(&self, _: &Id) {}
}

const DIM: &str = "2";
const ITALIC: &str = "3";

/// ANSI styles when on, `tracing-subscriber`'s: `ESC[<code>m`, the text, `ESC[0m`.
#[derive(Clone, Copy)]
struct Style(bool);

impl Style {
    fn paint(self, out: &mut String, code: &str, text: impl FnOnce(&mut String)) {
        if self.0 {
            let _ = write!(out, "\x1b[{code}m");
        }
        text(out);
        if self.0 {
            out.push_str("\x1b[0m");
        }
    }
}

/// `2026-11-06T21:20:29.018154Z`: UTC, to the microsecond.
fn timestamp(out: &mut String, at: SystemTime) {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (year, month, day) = crate::i18n::civil_from_days(seconds.div_euclid(86_400));
    let of_day = seconds.rem_euclid(86_400);
    let _ = write!(
        out,
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:06}Z",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60,
        since.subsec_micros()
    );
}

/// The level right-aligned in five columns, in its color.
fn level(out: &mut String, level: &Level, style: Style) {
    let (text, code) = match *level {
        Level::ERROR => ("ERROR", "31"),
        Level::WARN => (" WARN", "33"),
        Level::INFO => (" INFO", "32"),
        Level::DEBUG => ("DEBUG", "34"),
        _ => ("TRACE", "35"),
    };
    style.paint(out, code, |out| out.push_str(text));
}

/// The message as it is written, then `name=value` for each other field: `Debug` (a `str`
/// quoted), `Display` for `%value`, and an error's `Display` with the chain of its sources.
struct Fields<'a> {
    line: &'a mut String,
    first: bool,
    style: Style,
}

impl Fields<'_> {
    fn field(&mut self, field: &Field, value: fmt::Arguments<'_>) {
        let name = field.name();
        if !std::mem::take(&mut self.first) {
            self.line.push(' ');
        }
        if name != "message" {
            self.name(name.strip_prefix("r#").unwrap_or(name), "");
        }
        let _ = Escaped(self.line).write_fmt(value);
    }

    fn name(&mut self, name: &str, suffix: &str) {
        self.style.paint(self.line, ITALIC, |out| out.push_str(name));
        if !suffix.is_empty() {
            self.style.paint(self.line, ITALIC, |out| out.push_str(suffix));
        }
        self.style.paint(self.line, DIM, |out| out.push('='));
    }
}

impl Visit for Fields<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.field(field, format_args!("{value}"))
        } else {
            self.field(field, format_args!("{value:?}"))
        }
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.field(field, format_args!("{value}"));
        let Some(mut source) = value.source() else { return };
        self.line.push(' ');
        self.name(field.name(), ".sources");
        self.line.push('[');
        loop {
            let _ = write!(Escaped(self.line), "{source}");
            match source.source() {
                Some(next) => {
                    self.line.push_str(", ");
                    source = next;
                }
                None => break,
            }
        }
        self.line.push(']');
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.field(field, format_args!("{value:?}"))
    }
}

/// Text with every control character but a tab written as an escape: `\x1b` for the escape that
/// starts a terminal's color or cursor command, `\n` and `\r` for a line break, `\u{9b}` for a C1
/// control. The text between them is copied as it is, a run at a time.
struct Escaped<'a>(&'a mut String);

impl fmt::Write for Escaped<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let bytes = s.as_bytes();
        let (mut run, mut at) = (0, 0);
        while at < bytes.len() {
            // Each control is one byte, or a C1 control's two (`0xc2` then `0x80..=0x9f`), so
            // `at` is always where a character starts.
            let len = match bytes[at] {
                b'\t' => 0,
                0..=0x1f | 0x7f => 1,
                0xc2 if matches!(bytes.get(at + 1), Some(0x80..=0x9f)) => 2,
                _ => 0,
            };
            if len == 0 {
                at += 1;
                continue;
            }
            self.0.push_str(&s[run..at]);
            match bytes[at] {
                b'\n' => self.0.push_str("\\n"),
                b'\r' => self.0.push_str("\\r"),
                0xc2 => {
                    let _ = write!(self.0, "\\u{{{:x}}}", bytes[at + 1]);
                }
                control => {
                    let _ = write!(self.0, "\\x{control:02x}");
                }
            }
            at += len;
            run = at;
        }
        self.0.push_str(&s[run..]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Shared {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        /// The lines written, each without its timestamp (and the timestamp's style).
        fn lines(&self) -> Vec<String> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            text.lines().map(|l| l.split_once("Z").expect("a timestamp").1.to_string()).collect()
        }
    }

    fn ours(color: bool, f: impl FnOnce()) -> Vec<String> {
        let out = Shared::default();
        let sink = out.clone();
        let write = Box::new(move |l: &[u8]| sink.0.lock().unwrap().extend_from_slice(l));
        tracing::subscriber::with_default(Stdout { color, write }, f);
        out.lines()
    }

    fn theirs(color: bool, f: impl Fn()) -> Vec<String> {
        let out = Shared::default();
        let writer = out.clone();
        let subscriber =
            tracing_subscriber::fmt().with_target(false).with_ansi(color).with_writer(move || writer.clone()).finish();
        tracing::subscriber::with_default(subscriber, f);
        out.lines()
    }

    #[derive(Debug)]
    struct Failed(&'static str, Option<Box<Failed>>);

    impl fmt::Display for Failed {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Failed {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref().map(|e| e as _)
        }
    }

    /// Events as Corten writes them (startup, shutdown, a handler's error, an agent tool's), and
    /// an app's, with each kind of field.
    fn events() {
        tracing::info!("corten: listening");
        let grace = std::time::Duration::from_secs(5);
        tracing::warn!("corten: closed {} connection(s) still answering {grace:?} after shutdown began", 2);
        tracing::error!(status = 500u16, "corten: request failed: {}", "the store failed");
        let failed = Failed("the store failed", None);
        let error: &(dyn std::error::Error + 'static) = &failed;
        tracing::error!(error, tool = "lookup", "corten: agent tool failed");
        let chained =
            Failed("a handler failed", Some(Box::new(Failed("the store failed", Some(Box::new(Failed("reset", None)))))));
        let error: &(dyn std::error::Error + 'static) = &chained;
        tracing::error!(error, "an app's error with its sources");
        tracing::error!(%failed, ?failed, r#type = "x", flag = true, n = -3i64, f = 1.5f64, "a\x1b[31mred\u{9b}");
        tracing::warn!(limit_ms = 250u64, "corten: the ready check did not answer in time");
        tracing::info!(answer = 42);
        tracing::info!(log.id = 3, other = 1, "a field an app named log.");
        tracing::debug!("not printed");
        tracing::trace!("not printed");
        let span = tracing::info_span!("in_a_span", id = 7);
        let _entered = span.enter();
        tracing::info!("inside a span");
    }

    /// Every line but the one in a span is the line `tracing-subscriber`'s `fmt()` without
    /// targets writes, after its timestamp, in color and without; that one prints without the span.
    #[test]
    fn lines_are_tracing_subscriber_s() {
        for color in [false, true] {
            let (mine, expected) = (ours(color, events), theirs(color, events));
            assert_eq!(mine.len(), 10, "{mine:#?}");
            assert_eq!(mine.len(), expected.len(), "{mine:#?}\n{expected:#?}");
            assert_eq!(mine[..9], expected[..9], "color {color}");
        }
        assert_eq!(ours(false, events)[9], "  INFO inside a span");
        assert_eq!(theirs(false, events)[9], "  INFO in_a_span{id=7}: inside a span");
    }

    /// Colors on a terminal unless `NO_COLOR` is set to something; never off a terminal.
    #[test]
    fn colors_only_on_a_terminal_without_no_color() {
        assert!(colors(true, None));
        assert!(colors(true, Some("".into())));
        assert!(!colors(true, Some("1".into())));
        assert!(!colors(false, None));
        assert!(!colors(false, Some("".into())));
    }

    /// Text a request sent cannot start a line or send the terminal a command, in the message or
    /// in any other field; a tab stays.
    #[test]
    fn control_characters_are_escaped_in_every_field() {
        let forged = "x\r\n2026-01-01T00:00:00.000000Z ERROR forged\x0e\x1b[2J\tend";
        let lines = ours(false, || tracing::warn!(host = %forged, quoted = forged, "{forged}"));
        assert_eq!(lines.len(), 1, "{lines:#?}");
        let escaped = "x\\r\\n2026-01-01T00:00:00.000000Z ERROR forged\\x0e\\x1b[2J\tend";
        assert_eq!(lines[0], format!("  WARN {escaped} host={escaped} quoted={:?}", forged));
    }

    /// Each control at either end of the text and beside another, and every other character,
    /// multibyte ones and the one after the C1 controls (`\u{a0}`) among them, copied as it is.
    #[test]
    fn escaping_copies_all_but_the_controls() {
        let escape = |text: &str| {
            let mut out = String::new();
            let _ = fmt::Write::write_str(&mut Escaped(&mut out), text);
            out
        };
        assert_eq!(escape(""), "");
        assert_eq!(escape("plain é € 😀"), "plain é € 😀");
        assert_eq!(escape("\0a\x7f\x1f\t\u{80}\u{9f}\u{a0}ÿ\n"), "\\x00a\\x7f\\x1f\t\\u{80}\\u{9f}\u{a0}ÿ\\n");
        assert_eq!(escape("\r\r\u{85}é\u{9b}"), "\\r\\r\\u{85}é\\u{9b}");
    }

    #[crate::routes]
    mod access_test_url {
        #[route("/items/{id}", get = access_test_item)]
        pub struct Item {
            pub id: u32,
        }
    }

    async fn access_test_item(_: crate::Params<access_test_url::Item>) -> &'static str {
        "item"
    }

    fn access_app() -> crate::App {
        crate::App::new(access_test_url::router()).access_log(true).middleware(())
    }

    async fn access_call(router: crate::Router, method: &str, path: &str, headers: &[(&str, &str)]) -> crate::http::Response {
        use tower::ServiceExt;
        let mut req = crate::http::Request::builder().method(method).uri(path).header("host", "localhost");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        router.oneshot(req.body(crate::http::Body::empty()).unwrap()).await.unwrap()
    }

    fn access_lines(f: impl std::future::Future<Output = ()>) -> Vec<String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        ours(false, || runtime.block_on(f)).into_iter().filter(|line| line.contains("corten: request method=")).collect()
    }

    #[test]
    fn access_log_sees_host_and_cross_site_refusals() {
        let mut sizes = Vec::new();
        let lines = access_lines(async {
            use http_body_util::BodyExt;
            let router = access_app().router();
            let req = crate::http::Request::builder()
                .uri("/items/7?token=secret")
                .header("host", "rebound.attacker.example")
                .body(crate::http::Body::empty())
                .unwrap();
            use tower::ServiceExt;
            let res = router.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), http::StatusCode::MISDIRECTED_REQUEST);
            sizes.push(res.into_body().collect().await.unwrap().to_bytes().len());
            let res = access_call(router.clone(), "POST", "/items/7?token=secret", &[("sec-fetch-site", "cross-site")]).await;
            assert_eq!(res.status(), http::StatusCode::FORBIDDEN);
            sizes.push(res.into_body().collect().await.unwrap().to_bytes().len());
            // A second `Host` line: the host check's other refusal.
            let res = access_call(router, "GET", "/items/7?token=secret", &[("host", "localhost")]).await;
            assert_eq!(res.status(), http::StatusCode::BAD_REQUEST);
            sizes.push(res.into_body().collect().await.unwrap().to_bytes().len());
        });
        assert_eq!(lines.len(), 3, "{lines:?}");
        for (line, size) in lines.iter().zip(sizes) {
            assert!(line.contains("path=\"/items/7\"") && line.contains("route=\"/items/{id}\""), "{line}");
            assert!(line.contains(&format!("bytes={size} ")) && line.contains("duration="), "{line}");
            assert!(!line.contains("token") && !line.contains("secret"), "{line}");
        }
        assert!(lines[0].contains("method=GET") && lines[0].contains("status=421"), "{}", lines[0]);
        assert!(lines[1].contains("method=POST") && lines[1].contains("status=403"), "{}", lines[1]);
        assert!(lines[2].contains("method=GET") && lines[2].contains("status=400"), "{}", lines[2]);
    }

    #[crate::routes]
    mod access_lane_url {
        #[route("/lane/{id}", get = access_test_lane, unstaged)]
        pub struct Lane {
            pub id: u32,
        }
    }

    async fn access_test_lane(_: crate::Params<access_lane_url::Lane>) -> &'static str {
        "lane"
    }

    /// A route that says `unstaged` goes through none of the stages, and the line still sees
    /// what the host check answers in their place there: its `400` and its `421`.
    #[test]
    fn access_log_sees_the_host_check_s_refusals_at_an_unstaged_route() {
        let mut sizes = Vec::new();
        let lines = access_lines(async {
            use http_body_util::BodyExt;
            use tower::ServiceExt;
            let router = crate::App::new(access_lane_url::router()).access_log(true).router();
            // A second `Host` line; a `Host` that is no host; another host's name; the app's own.
            for (hosts, status) in [
                (&["localhost", "localhost"][..], http::StatusCode::BAD_REQUEST),
                (&["localhost/x"][..], http::StatusCode::BAD_REQUEST),
                (&["rebound.attacker.example"][..], http::StatusCode::MISDIRECTED_REQUEST),
                (&["localhost"][..], http::StatusCode::OK),
            ] {
                let mut req = crate::http::Request::builder().uri("/lane/7?token=secret");
                for host in hosts {
                    req = req.header("host", *host);
                }
                let res = router.clone().oneshot(req.body(crate::http::Body::empty()).unwrap()).await.unwrap();
                assert_eq!(res.status(), status, "{hosts:?}");
                // The lane's answer, not the stages': its own policy and none of the app's.
                assert_eq!(res.headers()[http::header::CONTENT_SECURITY_POLICY], "sandbox", "{hosts:?}");
                sizes.push(res.into_body().collect().await.unwrap().to_bytes().len());
            }
        });
        assert_eq!(lines.len(), 4, "{lines:?}");
        for ((line, size), status) in lines.iter().zip(sizes).zip([400, 400, 421, 200]) {
            assert!(line.contains("method=GET") && line.contains("path=\"/lane/7\""), "{line}");
            assert!(line.contains(&format!("route=\"/lane/{{id}}\" status={status} bytes={size} ")), "{line}");
            assert!(line.contains("duration=") && !line.contains("token") && !line.contains("secret"), "{line}");
        }
    }

    #[test]
    fn access_log_sees_a_304_and_a_head_with_no_body() {
        let lines = access_lines(async {
            use http_body_util::BodyExt;
            let router = access_app().router();
            // Ask to revalidate even without compression: the benchmark fast path makes no tag.
            let res = access_call(router.clone(), "GET", "/items/7", &[("if-none-match", "\"other\"")]).await;
            let tag = res.headers()[http::header::ETAG].to_str().unwrap().to_owned();
            assert_eq!(res.into_body().collect().await.unwrap().to_bytes().len(), 4);
            let res = access_call(router.clone(), "GET", "/items/7", &[("if-none-match", &tag)]).await;
            assert_eq!(res.status(), http::StatusCode::NOT_MODIFIED);
            assert!(res.into_body().collect().await.unwrap().to_bytes().is_empty());
            let res = access_call(router, "HEAD", "/items/7", &[]).await;
            assert_eq!(res.headers()[http::header::CONTENT_LENGTH], "4");
            assert!(res.into_body().collect().await.unwrap().to_bytes().is_empty());
        });
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert!(lines[0].contains("status=200 bytes=4 "), "{}", lines[0]);
        assert!(lines[1].contains("status=304 bytes=0 "), "{}", lines[1]);
        assert!(lines[2].contains("method=HEAD") && lines[2].contains("status=200 bytes=0 "), "{}", lines[2]);
    }

    #[test]
    fn access_log_sees_the_replacement_error_page_and_its_wait() {
        let mut size = 0;
        let lines = access_lines(async {
            use crate::prelude::*;
            use http_body_util::BodyExt;
            let router = access_app()
                .error_page(
                    |_: crate::Failure, req: Req| async move {
                        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
                        req.page::<crate::ForOne>(html! {
                            <!DOCTYPE html>
                            <html>
                                <head>
                                    <title>"Not here"</title>
                                    <Corten />
                                </head>
                                <body><main>"Replacement error page"</main></body>
                            </html>
                        })
                    },
                    (),
                )
                .router();
            let res = access_call(router, "GET", "/missing?secret=gone", &[]).await;
            assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
            let bytes = res.into_body().collect().await.unwrap().to_bytes();
            assert!(std::str::from_utf8(&bytes).unwrap().contains("Replacement error page"));
            size = bytes.len();
        });
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert!(line.contains(&format!("status=404 bytes={size} ")), "{line}");
        assert!(!line.contains("route=") && !line.contains("secret"), "{line}");
        let duration = line.split_once("duration=").unwrap().1;
        let elapsed = duration.strip_suffix("ms").map(|n| n.parse::<f64>().unwrap());
        assert!(
            elapsed.is_some_and(|ms| ms >= 15.0)
                || duration.strip_suffix('s').is_some_and(|n| n.parse::<f64>().is_ok_and(|s| s >= 0.015)),
            "{line}"
        );
    }

    #[test]
    fn access_log_marks_a_stream_without_polling_it() {
        let lines = access_lines(async {
            let routes = crate::router::Table::new().route(
                "/stream",
                crate::router::get(|| async {
                    crate::http::Body::from_stream(futures_util::stream::poll_fn(
                        |_| -> std::task::Poll<Option<Result<crate::http::Bytes, std::io::Error>>> {
                            panic!("logging must not poll a streamed body");
                        },
                    ))
                }),
            );
            let router = crate::App::new(crate::Routes::from(routes)).access_log(true).router();
            let res = access_call(router, "GET", "/stream", &[]).await;
            assert_eq!(res.status(), http::StatusCode::OK);
            assert!(http_body::Body::size_hint(res.body()).exact().is_none());
        });
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("status=200 bytes=\"stream\" "), "{}", lines[0]);
    }

    #[test]
    fn access_log_is_outside_app_layers_and_can_be_disabled() {
        let lines = access_lines(async {
            let layer = tower::util::MapResponseLayer::new(|mut res: crate::http::Response| {
                *res.status_mut() = http::StatusCode::CREATED;
                *res.body_mut() = crate::http::Body::from("layer's answer");
                res
            });
            let res = access_call(access_app().layer(layer).router(), "GET", "/items/7", &[]).await;
            assert_eq!(res.status(), http::StatusCode::CREATED);
            // The server writes the length of the body the layer left: nothing inside the layer
            // fixed one for the body it replaced.
            assert!(!res.headers().contains_key(http::header::CONTENT_LENGTH));
            assert_eq!(http_body::Body::size_hint(res.body()).exact(), Some(14));
            access_call(access_app().access_log(false).router(), "GET", "/items/7", &[]).await;
            access_call(crate::App::new(crate::Routes::new()).router(), "GET", "/missing", &[]).await;
        });
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("status=201 bytes=14 "), "{}", lines[0]);
    }

    #[test]
    fn access_log_keeps_the_route_across_a_spawned_layer_replacing_the_response() {
        let lines = access_lines(async {
            use crate::response::IntoResponse;
            use tower::ServiceExt;
            let layer = tower::layer::layer_fn(|inner: crate::Router| {
                tower::service_fn(move |req| {
                    let inner = inner.clone();
                    async move {
                        let res = tokio::spawn(async move { inner.oneshot(req).await }).await.unwrap()?;
                        assert_eq!(res.status(), http::StatusCode::OK);
                        Ok::<_, std::convert::Infallible>((http::StatusCode::CREATED, "replacement").into_response())
                    }
                })
            });
            access_call(access_app().layer(layer).router(), "GET", "/items/7", &[]).await;
        });
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("route=\"/items/{id}\" status=201 bytes=11 "), "{}", lines[0]);
    }

    #[test]
    fn access_log_counts_no_content_for_http_statuses_without_it() {
        let lines = access_lines(async {
            for status in [http::StatusCode::NO_CONTENT, http::StatusCode::NOT_MODIFIED, http::StatusCode::SWITCHING_PROTOCOLS] {
                let layer = tower::util::MapResponseLayer::new(move |mut res: crate::http::Response| {
                    *res.status_mut() = status;
                    res
                });
                access_call(access_app().layer(layer).router(), "GET", "/items/7", &[]).await;
            }
        });
        assert_eq!(lines.len(), 3, "{lines:?}");
        for (line, status) in lines.iter().zip([204, 304, 101]) {
            assert!(line.contains(&format!("status={status} bytes=0 ")), "{line}");
        }
    }

    /// Hyper's HTTP/1 server sends no final informational status but `101`: in place of a `100`
    /// or a `103` it writes an empty `500` and closes the connection, even one kept alive. The
    /// line says what the client got, over a real socket through `corten::serve`'s loop.
    #[test]
    fn access_log_records_the_500_a_client_gets_for_a_final_informational_status() {
        let mut answers = Vec::new();
        let lines = access_lines(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            for status in [http::StatusCode::CONTINUE, http::StatusCode::from_u16(103).unwrap()] {
                let layer = tower::util::MapResponseLayer::new(move |mut res: crate::http::Response| {
                    *res.status_mut() = status;
                    res
                });
                let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
                let addr = listeners[0].local_addr().unwrap();
                let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
                let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, access_app().layer(layer), async {
                    let _ = stopped.await;
                }));
                let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
                stream.write_all(b"GET /items/7 HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
                let mut answer = String::new();
                let read = tokio::time::timeout(std::time::Duration::from_secs(5), stream.read_to_string(&mut answer));
                read.await.expect("the server closes the kept-alive connection").unwrap();
                answers.push(answer);
                stop.send(()).unwrap();
                server.await.unwrap().unwrap();
            }
        });
        for answer in &answers {
            assert!(answer.starts_with("HTTP/1.1 500 "), "{answer}");
            assert_eq!(answer.split_once("\r\n\r\n").map(|(_, body)| body), Some(""), "{answer}");
        }
        assert_eq!(lines.len(), 2, "{lines:?}");
        for line in &lines {
            assert!(line.contains("route=\"/items/{id}\" status=500 bytes=0 "), "{line}");
        }
    }

    /// A response future dropped before it is ready (the client went away, a timeout around the
    /// router) writes no line: there is no answer to describe, and none is made up.
    #[test]
    fn access_log_writes_nothing_for_a_dropped_request() {
        let lines = access_lines(async {
            use tower::ServiceExt;
            let routes = crate::router::Table::new().route("/wait", crate::router::get(std::future::pending::<&'static str>));
            let router = crate::App::new(crate::Routes::from(routes)).access_log(true).router();
            let req = crate::http::Request::get("/wait").header("host", "localhost").body(crate::http::Body::empty()).unwrap();
            let waited = tokio::time::timeout(std::time::Duration::from_millis(20), router.oneshot(req)).await;
            assert!(waited.is_err(), "the handler never answers");
        });
        assert!(lines.is_empty(), "{lines:?}");
    }

    /// Takes only `corten::access` events that carry a `status` field, as a filter directive on
    /// the field does (`corten::access[{status}]=info`), and counts them.
    #[derive(Clone, Default)]
    struct WithStatus(std::sync::Arc<std::sync::atomic::AtomicUsize>);

    impl WithStatus {
        fn taken(&self) -> usize {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl Subscriber for WithStatus {
        fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
            Interest::sometimes()
        }

        fn enabled(&self, meta: &Metadata<'_>) -> bool {
            meta.target() == "corten::access" && meta.fields().field("status").is_some()
        }

        fn new_span(&self, _: &Attributes<'_>) -> Id {
            Id::from_u64(1)
        }

        fn record(&self, _: &Id, _: &Record<'_>) {}

        fn record_follows_from(&self, _: &Id, _: &Id) {}

        fn event(&self, _: &Event<'_>) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }

        fn enter(&self, _: &Id) {}

        fn exit(&self, _: &Id) {}
    }

    /// A subscriber that filters `corten::access` on one of the line's fields still gets the line:
    /// the check before a request asks about an event with the line's fields, not one with none.
    #[test]
    fn access_log_reaches_a_subscriber_that_filters_on_its_fields() {
        let subscriber = WithStatus::default();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tracing::subscriber::with_default(subscriber.clone(), || {
            tracing::info!(target: "corten::access", status = 200u16, "an event with a status");
            assert_eq!(subscriber.taken(), 1, "the subscriber takes a corten::access event with a status");
            runtime.block_on(async {
                access_call(access_app().router(), "GET", "/items/7", &[]).await;
            });
        });
        assert_eq!(subscriber.taken(), 2, "the request's line reaches it too");
    }

    /// A `2xx` to `CONNECT` opens a tunnel and has no HTTP content, so the line counts none even
    /// when the handler's body is a stream of unknown size; the client gets no content either.
    #[test]
    fn access_log_counts_no_content_for_a_connect_tunnel() {
        let mut answer = String::new();
        let lines = access_lines(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let routes = crate::router::Table::new().route(
                "/",
                crate::router::any(|| async {
                    let chunks = [Ok::<_, std::io::Error>(crate::http::Bytes::from_static(b"not content"))];
                    crate::http::Body::from_stream(futures_util::stream::iter(chunks))
                }),
            );
            let app = crate::App::new(crate::Routes::from(routes)).access_log(true);
            let listeners = crate::app::bind(Some("127.0.0.1"), 0).await.unwrap();
            let addr = listeners[0].local_addr().unwrap();
            let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
            let server = tokio::spawn(crate::app::run(listeners, crate::app::plain, app, async {
                let _ = stopped.await;
            }));
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            stream.write_all(b"CONNECT / HTTP/1.1\r\nhost: localhost\r\n\r\n").await.unwrap();
            // Everything sent until the connection closes or stays quiet.
            let mut read = Vec::new();
            let mut buf = [0u8; 256];
            while let Ok(Ok(n)) = tokio::time::timeout(std::time::Duration::from_millis(300), stream.read(&mut buf)).await {
                if n == 0 {
                    break;
                }
                read.extend_from_slice(&buf[..n]);
            }
            answer = String::from_utf8(read).unwrap();
            drop(stream);
            stop.send(()).unwrap();
            server.await.unwrap().unwrap();
        });
        assert!(answer.starts_with("HTTP/1.1 200 "), "{answer}");
        assert_eq!(answer.split_once("\r\n\r\n").map(|(_, body)| body), Some(""), "{answer}");
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("method=CONNECT") && lines[0].contains("status=200 bytes=0 "), "{}", lines[0]);
    }

    #[cfg(feature = "compress")]
    #[test]
    fn access_log_counts_the_compressed_body() {
        let mut size = 0;
        let lines = access_lines(async {
            use http_body_util::BodyExt;
            let routes = crate::router::Table::new().route("/large", crate::router::get(|| async { "x".repeat(4096) }));
            let router = crate::App::new(crate::Routes::from(routes)).access_log(true).router();
            let res = access_call(router, "GET", "/large", &[("accept-encoding", "gzip")]).await;
            assert_eq!(res.headers()[http::header::CONTENT_ENCODING], "gzip");
            size = res.into_body().collect().await.unwrap().to_bytes().len();
            assert!(size < 4096);
        });
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains(&format!("status=200 bytes={size} ")), "{}", lines[0]);
    }

    #[test]
    fn access_log_uses_its_target_and_the_route_actually_dispatched() {
        let out = Shared::default();
        let sink = out.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_target(true)
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(move || sink.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async {
                let rewrite = tower::util::MapRequestLayer::new(|mut req: crate::http::Request| {
                    *req.uri_mut() = http::Uri::from_static("/items/9");
                    req
                });
                access_call(access_app().layer(rewrite).router(), "GET", "/old?token=secret", &[]).await;
            });
        });
        let lines = out.lines();
        let line = lines.iter().find(|line| line.contains("corten: request ")).unwrap();
        assert!(line.contains("INFO corten::access:") && line.contains("path=\"/old\""), "{line}");
        assert!(line.contains("route=\"/items/{id}\"") && !line.contains("secret"), "{line}");
    }

    #[crate::routes]
    mod access_named_url {
        #[route("/pay/{step}", get = access_pay_step)]
        pub struct PayStep<'a> {
            pub step: &'a str,
        }

        #[route("/feeds/{name}.xml", get = access_feed)]
        pub struct Feed<'a> {
            pub name: &'a str,
        }

        #[route("/counts/{n}", get = access_count)]
        pub struct Count {
            pub n: u32,
        }

        // The app's only `POST`, so another route's is a `405`, not a `501`.
        #[route("/drafts", post = access_draft)]
        pub struct Drafts;
    }

    #[crate::routes(api = PayApi)]
    mod access_named_api {
        #[route("/pay/api")]
        pub struct PayApi;

        #[route("/pay/api/go", get = access_go)]
        pub struct Go;
    }

    async fn access_pay_step(at: crate::Params<access_named_url::PayStep<'_>>) -> String {
        format!("step {}", at.step)
    }

    async fn access_feed(at: crate::Params<access_named_url::Feed<'_>>) -> String {
        at.name.to_string()
    }

    async fn access_count(at: crate::Params<access_named_url::Count>) -> Result<String, crate::Error> {
        match at.n {
            0 => Err(crate::Error::status(crate::http::StatusCode::INTERNAL_SERVER_ERROR)),
            n => Ok(n.to_string()),
        }
    }

    async fn access_draft() -> &'static str {
        "draft"
    }

    async fn access_go() -> &'static str {
        "go"
    }

    /// The route named is the one that answered: not `/pay/{step}` for the API's own unknown URL,
    /// nor `/feeds/{name}.xml` for a segment without `.xml`, which are `404`s no route answered;
    /// but the route that matched, for its `400`, `405` and `500`. With an app layer and without.
    #[test]
    fn access_log_names_only_the_route_that_answered() {
        let cases = [
            ("GET", "/pay/one", 200, Some("/pay/{step}")),
            ("GET", "/pay/api", 404, None),
            ("GET", "/pay/api/go", 200, Some("/pay/api/go")),
            ("GET", "/feeds/news.xml", 200, Some("/feeds/{name}.xml")),
            ("GET", "/feeds/news.rss", 404, None),
            ("GET", "/counts/seven", 400, Some("/counts/{n}")),
            ("POST", "/counts/7", 405, Some("/counts/{n}")),
            ("GET", "/counts/0", 500, Some("/counts/{n}")),
        ];
        for layered in [false, true] {
            let lines = access_lines(async {
                let app = crate::App::new(access_named_url::router()).api(access_named_api::api).access_log(true);
                let router = match layered {
                    true => app.layer(tower::util::MapRequestLayer::new(|req: crate::http::Request| req)).router(),
                    false => app.router(),
                };
                for (method, path, status, _) in cases {
                    let res = access_call(router.clone(), method, path, &[]).await;
                    assert_eq!(res.status().as_u16(), status, "{method} {path} layered {layered}");
                }
            });
            assert_eq!(lines.len(), cases.len(), "{lines:?}");
            for (line, (method, path, status, route)) in lines.iter().zip(cases) {
                assert!(line.contains(&format!("method={method} path={path:?}")), "{line}");
                assert!(line.contains(&format!(" status={status} ")), "{line}");
                match route {
                    Some(route) => assert!(line.contains(&format!(" route={route:?} ")), "layered {layered}: {line}"),
                    None => assert!(!line.contains("route="), "layered {layered}: {line}"),
                }
            }
        }
    }

    #[crate::routes]
    mod access_url {
        #[route("/items/{id}/edit", get = access_item)]
        pub struct Item {
            pub id: u32,
        }
    }

    async fn access_item(at: crate::Params<access_url::Item>) -> String {
        format!("item {}", at.id)
    }

    /// CONTRIBUTING's request-path instruction count, with Corten's own subscriber writing to
    /// a sink. Run the release test binary under callgrind with `ACCESS_REQUESTS=1200` and 200,
    /// then subtract and divide by 1,000. `ACCESS_LOG=1` enables logging, `ACCESS_TARGET=missing`
    /// selects the 404, and `ACCESS_SINK=none` takes each event without formatting it, so the
    /// line's preparation and its formatting can be told apart. No socket or fixture is needed.
    #[test]
    #[ignore]
    fn what_an_access_request_costs() {
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let requests: usize = std::env::var("ACCESS_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let enabled = std::env::var("ACCESS_LOG").is_ok_and(|v| v == "1");
        let missing = std::env::var("ACCESS_TARGET").is_ok_and(|v| v == "missing");
        let formatted = !std::env::var("ACCESS_SINK").is_ok_and(|v| v == "none");
        let path = if missing { "/items/7/unknown" } else { "/items/7/edit" };
        let router = crate::App::new(access_url::router()).access_log(enabled).router();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let run = || {
            runtime.block_on(async {
                for _ in 0..requests {
                    let req = crate::http::Request::get(path).body(crate::http::Body::empty()).unwrap();
                    let res = router.clone().oneshot(req).await.unwrap();
                    assert_eq!(res.status().as_u16(), if missing { 404 } else { 200 });
                    let bytes = res.into_body().collect().await.unwrap().to_bytes();
                    if !missing {
                        assert_eq!(bytes.as_ref(), b"item 7");
                    }
                }
            })
        };
        if formatted {
            let write = Box::new(|line: &[u8]| {
                std::hint::black_box(line);
            });
            tracing::subscriber::with_default(Stdout { color: false, write }, run);
        } else {
            tracing::subscriber::with_default(Accepting, run);
        }
    }

    /// Takes the events [`Stdout`] takes and writes nothing.
    struct Accepting;

    impl Subscriber for Accepting {
        fn register_callsite(&self, meta: &'static Metadata<'static>) -> Interest {
            if wanted(meta) {
                Interest::always()
            } else {
                Interest::never()
            }
        }

        fn enabled(&self, meta: &Metadata<'_>) -> bool {
            wanted(meta)
        }

        fn max_level_hint(&self) -> Option<LevelFilter> {
            Some(LevelFilter::INFO)
        }

        fn new_span(&self, _: &Attributes<'_>) -> Id {
            Id::from_u64(1)
        }

        fn record(&self, _: &Id, _: &Record<'_>) {}

        fn record_follows_from(&self, _: &Id, _: &Id) {}

        fn event(&self, event: &Event<'_>) {
            std::hint::black_box(event);
        }

        fn enter(&self, _: &Id) {}

        fn exit(&self, _: &Id) {}
    }

    /// Refused only by `a_refused_link_is_logged_once_by_this_subscriber`, which needs the first
    /// refusal of its field in the process.
    #[cfg(not(debug_assertions))]
    #[derive(crate::Route)]
    #[route("/refused/{*path}")]
    struct Refused {
        path: String,
    }

    /// A link a release build refuses is logged once by this subscriber, the one `serve` installs
    /// when the app sets none: what decides whether a refusal is counted asks whether an error
    /// event would be logged, which this subscriber takes (docs/design.md#limit-path-values).
    #[cfg(not(debug_assertions))]
    #[test]
    fn a_refused_link_is_logged_once_by_this_subscriber() {
        use crate::route::Route as _;
        let lines = ours(false, || {
            assert_eq!(Refused { path: "a/..".into() }.href(), "/refused/a/..%FF");
            assert_eq!(Refused { path: "./b".into() }.href(), "/refused/.%FF/b");
        });
        assert_eq!(lines.len(), 1, "{lines:#?}");
        let named = format!("a link to {}::Refused cannot carry path = \"a/..\"", module_path!());
        assert!(lines[0].starts_with(" ERROR corten: ") && lines[0].contains(&named), "{named}: {}", lines[0]);
        assert!(lines[0].contains("logged once for this route and field"), "{}", lines[0]);
    }

    /// What one line costs: `LOG_LINES` events (default 1,000) with this subscriber, or
    /// `tracing-subscriber`'s when `LOG_SUBSCRIBER=theirs`, each written to a sink. Run under
    /// callgrind with two counts and take the difference.
    #[test]
    #[ignore]
    fn what_a_log_line_costs() {
        let n: u32 = std::env::var("LOG_LINES").ok().and_then(|n| n.parse().ok()).unwrap_or(1000);
        let run = || {
            for i in 0..n {
                tracing::warn!(status = 421u16, host = "rebound.attacker.example:18580", "corten: refused a request {i}");
            }
        };
        if std::env::var("LOG_SUBSCRIBER").as_deref() == Ok("theirs") {
            let subscriber = tracing_subscriber::fmt().with_target(false).with_ansi(false).with_writer(std::io::sink).finish();
            tracing::subscriber::with_default(subscriber, run);
        } else {
            let write = Box::new(|l: &[u8]| {
                std::hint::black_box(l);
            });
            tracing::subscriber::with_default(Stdout { color: false, write }, run);
        }
    }

    #[test]
    fn a_timestamp_is_utc_to_the_microsecond() {
        let mut out = String::new();
        timestamp(&mut out, UNIX_EPOCH + std::time::Duration::from_micros(1_774_191_845_018_154));
        assert_eq!(out, "2026-03-22T15:04:05.018154Z");
        out.clear();
        timestamp(&mut out, UNIX_EPOCH);
        assert_eq!(out, "1970-01-01T00:00:00.000000Z");
    }
}
