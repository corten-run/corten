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
/// control.
struct Escaped<'a>(&'a mut String);

impl fmt::Write for Escaped<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for ch in s.chars() {
            match ch {
                '\n' => self.0.push_str("\\n"),
                '\r' => self.0.push_str("\\r"),
                '\t' => self.0.push('\t'),
                '\0'..='\x1f' | '\x7f' => {
                    let _ = write!(self.0, "\\x{:02x}", ch as u32);
                }
                '\u{80}'..='\u{9f}' => {
                    let _ = write!(self.0, "\\u{{{:x}}}", ch as u32);
                }
                ch => self.0.push(ch),
            }
        }
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

    fn ours(color: bool, f: impl Fn()) -> Vec<String> {
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
