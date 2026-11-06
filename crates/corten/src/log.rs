//! The subscriber [`crate::serve`] installs when the app has set none (feature `log`): each
//! event at `INFO` or above as one line on stderr, as `tracing-subscriber`'s `fmt()` without
//! targets writes it (`2026-11-06T21:20:29.018154Z  WARN message key=value`), so errors,
//! startup and shutdown print without that crate and the four only it needs. Spans are off, so an
//! event prints without the spans it is in: an app that wants them, a filter or JSON lines sets a
//! subscriber of its own (`tracing-subscriber`) before `serve`, which then leaves it alone.
//! Control characters in what is printed are escaped, so text a request sent cannot move the
//! terminal's cursor or recolor it. The level is in color when stderr is a terminal and
//! `NO_COLOR` is unset.

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

/// Installs [`Stderr`] as the global subscriber unless one is set already.
pub(crate) fn init() {
    let color = std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty());
    let write = Box::new(|line: &[u8]| {
        let _ = std::io::stderr().lock().write_all(line);
    });
    let _ = tracing::subscriber::set_global_default(Stderr { color, write });
}

pub(crate) struct Stderr {
    color: bool,
    /// Where each line goes, in one write so lines from several threads do not interleave.
    write: Box<dyn Fn(&[u8]) + Send + Sync>,
}

fn wanted(meta: &Metadata<'_>) -> bool {
    meta.is_event() && *meta.level() <= Level::INFO
}

impl Subscriber for Stderr {
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

    // Spans are never enabled, so this is not called for one; an id is still a valid answer.
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}

    fn record_follows_from(&self, _: &Id, _: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut line = String::with_capacity(128);
        timestamp(&mut line, SystemTime::now());
        line.push(' ');
        level(&mut line, event.metadata().level(), self.color);
        line.push(' ');
        event.record(&mut Fields { line: &mut line, first: true });
        line.push('\n');
        (self.write)(line.as_bytes());
    }

    fn enter(&self, _: &Id) {}

    fn exit(&self, _: &Id) {}
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

/// The level right-aligned in five columns, in `tracing-subscriber`'s colors when `color`.
fn level(out: &mut String, level: &Level, color: bool) {
    let (text, code) = match *level {
        Level::ERROR => ("ERROR", "31"),
        Level::WARN => (" WARN", "33"),
        Level::INFO => (" INFO", "32"),
        Level::DEBUG => ("DEBUG", "34"),
        _ => ("TRACE", "35"),
    };
    if color {
        let _ = write!(out, "\x1b[{code}m{text}\x1b[0m");
    } else {
        out.push_str(text);
    }
}

/// The message as it is written, then `name=value` for each other field: `Debug` (a `str`
/// quoted), and `Display` for `%value` and an error.
struct Fields<'a> {
    line: &'a mut String,
    first: bool,
}

impl Fields<'_> {
    fn field(&mut self, field: &Field, value: fmt::Arguments<'_>) {
        if !std::mem::take(&mut self.first) {
            self.line.push(' ');
        }
        let name = field.name();
        if name != "message" {
            self.line.push_str(name.strip_prefix("r#").unwrap_or(name));
            self.line.push('=');
        }
        let _ = Escaped(self.line).write_fmt(value);
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
        self.field(field, format_args!("{value}"))
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.field(field, format_args!("{value:?}"))
    }
}

/// Text with the control characters a terminal acts on (escape, bell, backspace, form feed,
/// delete and C1) written as escapes, as `tracing-subscriber` writes a message.
struct Escaped<'a>(&'a mut String);

impl fmt::Write for Escaped<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for ch in s.chars() {
            match ch {
                '\x1b' => self.0.push_str("\\x1b"),
                '\x07' => self.0.push_str("\\x07"),
                '\x08' => self.0.push_str("\\x08"),
                '\x0c' => self.0.push_str("\\x0c"),
                '\x7f' => self.0.push_str("\\x7f"),
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
        /// The lines written, each without its timestamp.
        fn lines(&self) -> Vec<String> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            text.lines().map(|l| l.split_once(' ').expect("a timestamp").1.to_string()).collect()
        }
    }

    #[derive(Debug)]
    struct Failed;

    impl fmt::Display for Failed {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("the store failed")
        }
    }

    impl std::error::Error for Failed {}

    /// Events as Corten writes them (startup, shutdown, a handler's error, an agent tool's), with
    /// each kind of field.
    fn events() {
        tracing::info!("corten: listening");
        let grace = std::time::Duration::from_secs(5);
        tracing::warn!("corten: closed {} connection(s) still answering {grace:?} after shutdown began", 2);
        tracing::error!(status = 500u16, "corten: request failed: {}", "the store failed");
        let failed = Failed;
        let error: &(dyn std::error::Error + 'static) = &failed;
        tracing::error!(error, tool = "lookup", "corten: agent tool failed");
        tracing::error!(%failed, ?failed, r#type = "x", flag = true, n = -3i64, f = 1.5f64, "a\x1b[31mred\u{9b}");
        tracing::warn!(limit_ms = 250u64, "corten: the ready check did not answer in time");
        tracing::info!(answer = 42);
        tracing::debug!("not printed");
        tracing::trace!("not printed");
        let span = tracing::info_span!("in_a_span", id = 7);
        let _entered = span.enter();
        tracing::info!("inside a span");
    }

    /// Every line but the one in a span is the line `tracing-subscriber`'s `fmt()` without
    /// targets writes, after its timestamp; that one prints without the span.
    #[test]
    fn lines_are_tracing_subscriber_s() {
        let ours = Shared::default();
        let sink = ours.clone();
        let write = Box::new(move |l: &[u8]| sink.0.lock().unwrap().extend_from_slice(l));
        tracing::subscriber::with_default(Stderr { color: false, write }, events);

        let theirs = Shared::default();
        let writer = theirs.clone();
        let subscriber =
            tracing_subscriber::fmt().with_target(false).with_ansi(false).with_writer(move || writer.clone()).finish();
        tracing::subscriber::with_default(subscriber, events);

        let (mine, expected) = (ours.lines(), theirs.lines());
        assert_eq!(mine.len(), 8, "{mine:#?}");
        assert_eq!(mine.len(), expected.len(), "{mine:#?}\n{expected:#?}");
        assert_eq!(mine[..7], expected[..7]);
        assert_eq!(mine[7], " INFO inside a span");
        assert_eq!(expected[7], " INFO in_a_span{id=7}: inside a span");
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
            tracing::subscriber::with_default(Stderr { color: false, write: Box::new(|l| drop(std::hint::black_box(l))) }, run);
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

    #[test]
    fn the_level_is_in_color_only_when_asked() {
        let mut out = String::new();
        level(&mut out, &Level::WARN, true);
        level(&mut out, &Level::ERROR, false);
        assert_eq!(out, "\x1b[33m WARN\x1b[0mERROR");
    }
}
