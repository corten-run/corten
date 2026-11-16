//! A date and time on a clock, with no zone ([`LocalDateTime`]): what
//! `<input type="datetime-local">` sends, read as the instant it names in a zone and written back.

use std::fmt::{self, Display, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{Day, Zone};
use crate::view::{quoted, AttrValue, Render};

/// Milliseconds in a day.
const DAY: i64 = 86_400_000;

/// A date and a time of day on a clock, with no zone: what `<input type="datetime-local">`
/// sends (`2026-11-13T14:05`), the time a person reads off the clock where they are. It names an
/// instant only in a zone, so it is not one: [`at`](LocalDateTime::at) reads it in a zone, and
/// [`of`](LocalDateTime::of) writes an instant in a zone as the input's `value`, `min` or
/// `max`. A field the user fills in is an [`Entry<LocalDateTime>`](crate::form::Entry), which
/// keeps the text when it does not read and is read in the zone its form was drawn in, a
/// [`FormZone`](crate::form::FormZone) the form sends back with it.
///
/// ```
/// use corten::i18n::{parse_timestamp, LocalDateTime, Offset};
///
/// let zone = Offset::hours(-6); // in a handler, the form's FormZone
/// let read: LocalDateTime = "2026-11-13T14:05".parse().unwrap();
/// let at = read.at(zone).unwrap();
/// assert_eq!(Some(at), parse_timestamp("2026-11-13T20:05:00Z"));
/// assert_eq!(LocalDateTime::of(at, zone).unwrap().to_string(), "2026-11-13T14:05");
/// ```
///
/// Where the clocks change, a time on the clock names no instant (skipped, `02:30` on the
/// morning the clocks go from 2 to 3) or two (repeated, `01:30` on the night they go from 2 back
/// to 1). [`at`](LocalDateTime::at) has one answer for both, the one JavaScript's `Date`, Temporal's
/// default (`disambiguation: "compatible"`) and iCalendar (RFC 5545) give: a skipped time is read
/// at the offset before the change, so it moves forward by the gap (`02:30` is `03:30`), and a
/// repeated time is the earlier of the two (before the clocks go back):
///
/// ```
/// # #[cfg(feature = "zones")]
/// # {
/// use corten::i18n::{parse_timestamp, LocalDateTime, Visitor};
///
/// let chicago = Visitor::named("America/Chicago");
/// let skipped: LocalDateTime = "2026-03-08T02:30".parse().unwrap();
/// assert_eq!(skipped.at(&chicago), parse_timestamp("2026-03-08T03:30:00-05:00"));
/// let repeated: LocalDateTime = "2026-11-01T01:30".parse().unwrap();
/// assert_eq!(repeated.at(&chicago), parse_timestamp("2026-11-01T01:30:00-05:00"));
/// # }
/// ```
///
/// [`of`](LocalDateTime::of) then [`at`](LocalDateTime::at) gives the instant back, except in
/// an hour the clocks repeat: the second `01:30` (`07:30Z` in Chicago) is drawn as `01:30`,
/// which reads as the first (`06:30Z`). A form that edits a stored instant keeps it when the
/// field comes back as it was drawn: compare the field's value with `LocalDateTime::of(stored,
/// zone)` before reading it.
///
/// It reads and writes HTML's syntax for a local date and time: a [`Day`], `T` (or a space) and
/// the time to the minute, with seconds and up to three digits of a second when the input's
/// `step` asks for them (`2026-11-13T14:05:09.5`). It is written as HTML normalizes one, which
/// is what a browser sends: with `T`, and with the seconds and their fraction only where they are
/// not zero. An input counts its steps (a minute unless `step` says otherwise) from its `min`,
/// else its `value`, so a `min` with seconds or a fraction of one puts every whole minute off a
/// step and the form is not sent until the visitor picks a time that is on one (`corten dev`
/// names such a control drawn with a value). Draw a `min` rounded up to the minute and a `max`
/// rounded down ([`ceil_minute`](LocalDateTime::ceil_minute),
/// [`floor_minute`](LocalDateTime::floor_minute)): every minute between them is then a step, and
/// each one reads as an instant inside the bounds the handler compares with.
///
/// ```
/// use corten::i18n::{parse_timestamp, LocalDateTime, Utc};
///
/// let listed = parse_timestamp("2026-11-12T15:30:09.250Z").unwrap();
/// let min = LocalDateTime::of(listed, Utc).and_then(LocalDateTime::ceil_minute).unwrap();
/// assert_eq!(min.to_string(), "2026-11-12T15:31");
/// assert!(min.at(Utc).unwrap() >= listed, "the earliest time the input allows is not before it");
/// let max = LocalDateTime::of(listed, Utc).unwrap().floor_minute();
/// assert_eq!(max.to_string(), "2026-11-12T15:30");
/// ```
///
/// A time on the clock is not an instant, so it is not written as one without its zone:
///
/// ```compile_fail,E0277
/// use corten::i18n::{DateStyle, LocalDateTime, Messages as _};
/// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
///
/// let read: LocalDateTime = "2026-11-13T14:05".parse().unwrap();
/// let _ = Msg::for_locale("en").date(read, DateStyle::Medium);
/// ```
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocalDateTime {
    day: Day,
    /// Milliseconds after the day's midnight on the clock, below a day's.
    millis: u32,
}

impl LocalDateTime {
    /// `hour:minute:second` on `day` (24-hour clock), or `None` for a time that is not one
    /// (`24:00`, a 60th second).
    pub fn new(day: Day, hour: u32, minute: u32, second: u32) -> Option<Self> {
        (hour < 24 && minute < 60 && second < 60)
            .then(|| LocalDateTime { day, millis: (hour * 3600 + minute * 60 + second) * 1000 })
    }

    /// `00:00` on `day`.
    pub(super) fn midnight(day: Day) -> Self {
        LocalDateTime { day, millis: 0 }
    }

    pub fn day(self) -> Day {
        self.day
    }

    /// 0 to 23.
    pub fn hour(self) -> u32 {
        self.millis / 3_600_000
    }

    /// 0 to 59.
    pub fn minute(self) -> u32 {
        self.millis / 60_000 % 60
    }

    /// 0 to 59.
    pub fn second(self) -> u32 {
        self.millis / 1000 % 60
    }

    /// 0 to 999.
    pub fn millisecond(self) -> u32 {
        self.millis % 1000
    }

    /// The minute it is in (`14:05:09` is `14:05`), for an input's `max`.
    pub fn floor_minute(self) -> Self {
        LocalDateTime { millis: self.millis - self.millis % 60_000, ..self }
    }

    /// The first whole minute at or after it (`14:05:09` is `14:06`), for an input's `min`;
    /// `None` past `9999-12-31T23:59`.
    pub fn ceil_minute(self) -> Option<Self> {
        let down = self.floor_minute();
        if down == self {
            return Some(self);
        }
        match down.millis + 60_000 {
            next if i64::from(next) < DAY => Some(LocalDateTime { millis: next, ..self }),
            _ => Day::from_days(self.day.days() + 1).map(LocalDateTime::midnight),
        }
    }

    /// What the clock in `zone` reads at `at`, to the millisecond (rounded down): for the
    /// `value`, `min` or `max` of an `<input type="datetime-local">`, drawn in the form's zone
    /// (`min={LocalDateTime::of(listed, &zone)}`, a [`FormZone`](crate::form::FormZone)) that the
    /// form sends back and the handler reads what the visitor picked in. `None` outside the years a
    /// [`Day`] has (1 to 9999).
    pub fn of(at: impl Into<SystemTime>, zone: impl Zone) -> Option<Self> {
        let at = at.into();
        let local = unix_millis(at)?.checked_add(i64::from(zone.offset(at)) * 1000)?;
        let day = Day::from_days(local.div_euclid(DAY))?;
        Some(LocalDateTime { day, millis: local.rem_euclid(DAY) as u32 })
    }

    /// The instant this time on the clock is in `zone`: a skipped time moves forward by the gap, and a repeated time is the earlier instant, as the
    /// [type](LocalDateTime) says. `None` before the earliest `SystemTime` the platform has
    /// (1601-01-01 on Windows).
    ///
    /// It asks the zone for its offset a day before and a day after, so a zone whose offset
    /// changed twice within two days would be read with the outer two.
    pub fn at(self, zone: impl Zone) -> Option<SystemTime> {
        // The clock's reading as if it were UTC's; the instant is that minus the offset there.
        let local = self.day.days() * DAY + i64::from(self.millis);
        let offset = |utc: i64| instant(utc).map(|at| i64::from(zone.offset(at)) * 1000);
        let (before, after) = (offset(local - DAY)?, offset(local + DAY)?);
        // Whether the clock reads `local` at the instant it gives with offset `o`.
        let holds = |o: i64| offset(local - o) == Some(o);
        // Repeated: both hold, and the offset before is the larger, so its instant is the earlier.
        // Skipped: neither holds, and the offset before moves it forward by the gap.
        instant(if holds(before) || !holds(after) { local - before } else { local - after })
    }
}

/// Milliseconds since 1970-01-01, rounded down; `None` past an `i64`.
fn unix_millis(at: SystemTime) -> Option<i64> {
    match at.duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_millis()).ok(),
        Err(before) => {
            let d = before.duration();
            let ms = d.as_millis() + u128::from(!d.as_nanos().is_multiple_of(1_000_000));
            i64::try_from(ms).ok().map(|ms| -ms)
        }
    }
}

/// The instant `ms` milliseconds from 1970-01-01, if the platform has it.
fn instant(ms: i64) -> Option<SystemTime> {
    let d = Duration::from_millis(ms.unsigned_abs());
    if ms >= 0 {
        UNIX_EPOCH.checked_add(d)
    } else {
        UNIX_EPOCH.checked_sub(d)
    }
}

/// What [`LocalDateTime`]'s `parse` refused: not a date and time in HTML's syntax
/// (`YYYY-MM-DDTHH:MM`, with `:SS` and `.sss` if it has them), or no such day or time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidLocalDateTime;

impl Display for InvalidLocalDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not a date and time as YYYY-MM-DDTHH:MM")
    }
}

impl std::error::Error for InvalidLocalDateTime {}

impl std::str::FromStr for LocalDateTime {
    type Err = InvalidLocalDateTime;

    /// HTML's valid local date and time string, as `<input type="datetime-local">` sends it:
    /// `2026-11-13T14:05`, a space for the `T`, `:09` seconds, `.5` to `.125` of a second. Nothing
    /// else (an offset, `14:5`, spaces around it, a fourth digit of a second).
    fn from_str(text: &str) -> Result<Self, InvalidLocalDateTime> {
        let b = text.as_bytes();
        if b.len() < 16 || !matches!(b[10], b'T' | b' ') || b[13] != b':' {
            return Err(InvalidLocalDateTime);
        }
        let day: Day = text.get(..10).and_then(|day| day.parse().ok()).ok_or(InvalidLocalDateTime)?;
        let digits = |at: &[u8]| at.iter().try_fold(0u32, |n, &c| c.is_ascii_digit().then(|| n * 10 + u32::from(c - b'0')));
        let (hour, minute) = (digits(&b[11..13]), digits(&b[14..16]));
        let (second, fraction) = match &b[16..] {
            [] => (Some(0), Some(0)),
            [b':', s @ ..] if s.len() == 2 => (digits(s), Some(0)),
            [b':', s0, s1, b'.', f @ ..] if (1..=3).contains(&f.len()) => {
                (digits(&[*s0, *s1]), digits(f).map(|n| n * 10u32.pow(3 - f.len() as u32)))
            }
            _ => (None, None),
        };
        let (Some(hour), Some(minute), Some(second), Some(fraction)) = (hour, minute, second, fraction) else {
            return Err(InvalidLocalDateTime);
        };
        let read = LocalDateTime::new(day, hour, minute, second).ok_or(InvalidLocalDateTime)?;
        Ok(LocalDateTime { millis: read.millis + fraction, ..read })
    }
}

/// HTML's normalized form, as a browser sends it: `2026-11-13T14:05`, with `:09` and `.5` only
/// when they are not zero.
impl Display for LocalDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}T{:02}:{:02}", self.day, self.hour(), self.minute())?;
        let (second, ms) = (self.second(), self.millisecond());
        if second != 0 || ms != 0 {
            write!(f, ":{second:02}")?;
        }
        match ms {
            0 => Ok(()),
            _ if ms.is_multiple_of(100) => write!(f, ".{}", ms / 100),
            _ if ms.is_multiple_of(10) => write!(f, ".{:02}", ms / 10),
            _ => write!(f, ".{ms:03}"),
        }
    }
}

impl fmt::Debug for LocalDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LocalDateTime({self})")
    }
}

impl Render for LocalDateTime {
    fn render(&self, out: &mut String) {
        let _ = write!(out, "{self}");
    }
}

/// The input's `value`, `min` or `max`: `value="2026-11-13T14:05"`.
impl AttrValue for LocalDateTime {
    fn write_attr(&self, name: &str, out: &mut String) {
        quoted(name, self, out);
    }
}

/// Read from text, as a form's or a query's field (a hidden input a page writes itself). It has no
/// `Serialize`: JSON an app sends carries an instant with its offset (RFC 3339), not a clock
/// reading with no zone.
impl<'de> serde::Deserialize<'de> for LocalDateTime {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl serde::de::Visitor<'_> for Visit {
            type Value = LocalDateTime;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a date and time as YYYY-MM-DDTHH:MM")
            }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<LocalDateTime, E> {
                text.parse().map_err(|_| E::invalid_value(serde::de::Unexpected::Str(text), &self))
            }
        }
        deserializer.deserialize_str(Visit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{parse_timestamp, Offset, Utc};

    fn read(text: &str) -> LocalDateTime {
        text.parse().unwrap_or_else(|_| panic!("{text:?} reads"))
    }

    #[test]
    fn it_reads_html_syntax_and_writes_its_normalized_form() {
        for (text, written) in [
            ("2026-11-13T14:05", "2026-11-13T14:05"),
            ("2026-11-13 14:05", "2026-11-13T14:05"),
            ("2026-11-13T14:05:00", "2026-11-13T14:05"),
            ("2026-11-13T14:05:00.000", "2026-11-13T14:05"),
            ("2026-11-13T14:05:09", "2026-11-13T14:05:09"),
            ("2026-11-13T14:05:00.5", "2026-11-13T14:05:00.5"),
            ("2026-11-13T14:05:09.50", "2026-11-13T14:05:09.5"),
            ("2026-11-13T14:05:09.25", "2026-11-13T14:05:09.25"),
            ("2026-11-13T14:05:09.125", "2026-11-13T14:05:09.125"),
            ("2026-11-13T00:00", "2026-11-13T00:00"),
            ("2024-02-29T23:59:59.999", "2024-02-29T23:59:59.999"),
            ("0001-01-01T00:00", "0001-01-01T00:00"),
            ("9999-12-31T23:59", "9999-12-31T23:59"),
        ] {
            assert_eq!(read(text).to_string(), written, "{text}");
            assert_eq!(read(written), read(text), "{written} reads back");
        }
        for text in [
            "",
            "2026-11-13",
            "2026-11-13T",
            "2026-11-13T14",
            "2026-11-13T14:5",
            "2026-11-13T4:05",
            "2026-11-13t14:05",
            "2026-11-13T14:05Z",
            "2026-11-13T14:05:00Z",
            "2026-11-13T14:05-06:00",
            "2026-11-13T14:05:9",
            "2026-11-13T14:05:09.",
            "2026-11-13T14:05:09.1234",
            "2026-11-13T14:05.5",
            "2026-11-13T24:00",
            "2026-11-13T23:60",
            "2026-11-13T23:59:60",
            "2026-02-29T12:00",
            "2026-11-13T14:05 ",
            " 2026-11-13T14:05",
            "2026-11-13T+4:05",
            "02026-11-13T14:05",
            "0000-12-31T23:59",
            "2026-11-13\u{a0}14:05",
            "2026-11-1\u{e9}T14:05",
        ] {
            assert_eq!(text.parse::<LocalDateTime>(), Err(InvalidLocalDateTime), "{text:?}");
        }
        let t = read("2026-11-13T14:05:09.125");
        assert_eq!(
            (t.day().to_string(), t.hour(), t.minute(), t.second(), t.millisecond()),
            ("2026-11-13".into(), 14, 5, 9, 125)
        );
        assert!(
            read("2026-11-13T14:05") < read("2026-11-13T14:05:00.001") && read("2026-11-12T23:59") < read("2026-11-13T00:00")
        );
        assert_eq!(LocalDateTime::new(Day::new(2026, 11, 13).unwrap(), 14, 5, 0), Some(read("2026-11-13T14:05")));
        assert_eq!(LocalDateTime::new(Day::new(2026, 11, 13).unwrap(), 24, 0, 0), None);
        let mut out = String::new();
        read("2026-11-13T14:05").write_attr(" min", &mut out);
        assert_eq!(out, r#" min="2026-11-13T14:05""#);
    }

    #[test]
    fn a_fixed_offset_reads_and_writes_the_same_instant() {
        let at = parse_timestamp("2026-11-13T20:05:09.250Z").unwrap();
        for (zone, written) in [
            (Offset::hours(-6), "2026-11-13T14:05:09.25"),
            (Offset::seconds(5 * 3600 + 1800), "2026-11-14T01:35:09.25"),
            (Offset::hours(14), "2026-11-14T10:05:09.25"),
        ] {
            let local = LocalDateTime::of(at, zone).unwrap();
            assert_eq!(local.to_string(), written);
            assert_eq!(local.at(zone), Some(at), "{written} reads back as the instant");
        }
        assert_eq!(LocalDateTime::of(at, Utc).unwrap().to_string(), "2026-11-13T20:05:09.25");
        // Before 1970 it rounds down too, so the clock reads what it read a moment before.
        let before = UNIX_EPOCH - Duration::from_nanos(1);
        assert_eq!(LocalDateTime::of(before, Utc).unwrap().to_string(), "1969-12-31T23:59:59.999");
        assert_eq!(read("1969-12-31T23:59:59.999").at(Utc), Some(UNIX_EPOCH - Duration::from_millis(1)));
        // A day reads only within the years a Day has.
        assert_eq!(LocalDateTime::of(parse_timestamp("9999-12-31T23:00:00Z").unwrap(), Offset::hours(2)), None);
    }

    /// A zone that moves its clocks at fixed instants, as a rule in the tz database does, to
    /// read the gaps and repeats with no database: `(at or after, offset)`, in order.
    struct Changes(Vec<(i64, i32)>);

    impl Zone for Changes {
        fn offset(&self, at: SystemTime) -> i32 {
            let ms = unix_millis(at).unwrap();
            self.0.iter().take_while(|(from, _)| ms >= from * 1000).last().map_or(self.0[0].1, |c| c.1)
        }
    }

    #[test]
    fn a_skipped_time_moves_forward_by_the_gap_and_a_repeated_one_is_the_earlier() {
        let ts = |text: &str| parse_timestamp(text).unwrap();
        let secs = |text: &str| unix_millis(ts(text)).unwrap() / 1000;
        // Clocks go from 02:00 to 03:00 at 08:00Z, then from 02:00 back to 01:00 at 07:00Z.
        let zone =
            Changes(vec![(0, -6 * 3600), (secs("2026-03-08T08:00:00Z"), -5 * 3600), (secs("2026-11-01T07:00:00Z"), -6 * 3600)]);
        for (local, instant) in [
            ("2026-03-08T01:59:59.999", "2026-03-08T07:59:59.999Z"),
            ("2026-03-08T02:00", "2026-03-08T08:00:00Z"),
            ("2026-03-08T02:30", "2026-03-08T08:30:00Z"),
            ("2026-03-08T02:59:59.999", "2026-03-08T08:59:59.999Z"),
            ("2026-03-08T03:00", "2026-03-08T08:00:00Z"),
            ("2026-11-01T00:59", "2026-11-01T05:59:00Z"),
            ("2026-11-01T01:00", "2026-11-01T06:00:00Z"),
            ("2026-11-01T01:30", "2026-11-01T06:30:00Z"),
            ("2026-11-01T01:59:59.999", "2026-11-01T06:59:59.999Z"),
            ("2026-11-01T02:00", "2026-11-01T08:00:00Z"),
        ] {
            assert_eq!(read(local).at(&zone), Some(ts(instant)), "{local}");
        }
        // An instant reads back as the clock showed it, the second 01:30 included.
        assert_eq!(LocalDateTime::of(ts("2026-11-01T07:30:00Z"), &zone).unwrap().to_string(), "2026-11-01T01:30");
        assert_eq!(LocalDateTime::of(ts("2026-03-08T08:00:00Z"), &zone).unwrap().to_string(), "2026-03-08T03:00");
    }

    #[test]
    fn a_day_starts_where_its_clock_first_reads_it() {
        let ts = |text: &str| parse_timestamp(text).unwrap();
        let secs = |text: &str| unix_millis(ts(text)).unwrap() / 1000;
        // Midnight skipped to 01:00 at 03:00Z, and 01:00 back to midnight at 02:00Z.
        let zone =
            Changes(vec![(0, -3 * 3600), (secs("2018-11-04T03:00:00Z"), -2 * 3600), (secs("2019-02-17T02:00:00Z"), -3 * 3600)]);
        assert_eq!(Day::new(2018, 11, 4).unwrap().start(&zone), Some(ts("2018-11-04T03:00:00Z")));
        assert_eq!(Day::new(2019, 2, 16).unwrap().start(&zone), Some(ts("2019-02-16T02:00:00Z")));
        assert_eq!(Day::new(2019, 2, 17).unwrap().start(&zone), Some(ts("2019-02-17T03:00:00Z")));
        assert_eq!(Day::new(2026, 9, 2).unwrap().start(Utc), parse_timestamp("2026-09-02T00:00:00Z"));
    }

    /// At real changes in the bundled tz database: a 30-minute change, a skipped day and a
    /// skipped midnight.
    #[cfg(feature = "zones")]
    #[test]
    fn real_zones_skip_forward_and_take_the_earlier_repeat() {
        use crate::i18n::Visitor;
        let ts = |text: &str| parse_timestamp(text).unwrap();
        for (zone, local, instant) in [
            ("America/Chicago", "2026-03-08T02:30", "2026-03-08T03:30:00-05:00"),
            ("America/Chicago", "2026-11-01T01:30", "2026-11-01T01:30:00-05:00"),
            ("America/Chicago", "2026-11-01T02:00", "2026-11-01T02:00:00-06:00"),
            ("Europe/London", "2026-03-29T01:30", "2026-03-29T02:30:00+01:00"),
            ("Europe/London", "2026-10-25T01:30", "2026-10-25T01:30:00+01:00"),
            // Lord Howe Island moves its clocks by 30 minutes.
            ("Australia/Lord_Howe", "2026-10-04T02:15", "2026-10-04T02:45:00+11:00"),
            ("Australia/Lord_Howe", "2026-04-05T01:45", "2026-04-05T01:45:00+11:00"),
            // Samoa skipped 2011-12-30 to cross the date line.
            ("Pacific/Apia", "2011-12-30T12:00", "2011-12-31T12:00:00+14:00"),
            ("Pacific/Apia", "2011-12-29T23:59", "2011-12-29T23:59:00-10:00"),
        ] {
            assert_eq!(read(local).at(Visitor::named(zone)), Some(ts(instant)), "{local} in {zone}");
        }
        // Sao Paulo moved its clocks at midnight: the day began at 01:00.
        let sao_paulo = Visitor::named("America/Sao_Paulo");
        assert_eq!(Day::new(2018, 11, 4).unwrap().start(&sao_paulo), Some(ts("2018-11-04T01:00:00-02:00")));
        assert_eq!(Day::new(2019, 2, 17).unwrap().start(&sao_paulo), Some(ts("2019-02-17T00:00:00-03:00")));
        assert_eq!(LocalDateTime::of(ts("2026-11-15T09:00:00Z"), &sao_paulo).unwrap().to_string(), "2026-11-15T06:00");
    }

    /// In every zone in the bundled tz database, around every change of offset from 1970 to 2040,
    /// `at` gives the instant jiff's `compatible()` gives (Temporal's default) and `of` reads it back
    /// as jiff's clock does; and no zone changes its offset twice within two days, which `at`'s
    /// reading a day either side relies on.
    #[cfg(feature = "zones")]
    #[test]
    fn every_change_in_every_zone_reads_as_temporal_compatible_reads_it() {
        use crate::i18n::Visitor;
        use jiff::{tz::TimeZone, Timestamp};
        let from = Timestamp::from_second(0).unwrap();
        let until = Timestamp::from_second(2_208_988_800).unwrap(); // 2040
        let (mut zones, mut changes, mut checked) = (0, 0, 0);
        for name in jiff::tz::db().available() {
            let name = name.as_str();
            let (tz, zone) = (TimeZone::get(name).unwrap(), Visitor::named(name));
            assert!(zone.is_known(), "{name}");
            zones += 1;
            let mut last: Option<i64> = None;
            for change in tz.following(from).take_while(|c| c.timestamp() < until) {
                let at = change.timestamp().as_millisecond();
                let before = i64::from(tz.to_offset(Timestamp::from_millisecond(at - 1).unwrap()).seconds()) * 1000;
                let after = i64::from(change.offset().seconds()) * 1000;
                if before == after {
                    continue; // a new abbreviation or daylight flag, the clock unmoved
                }
                if let Some(last) = last {
                    assert!(at - last >= 2 * DAY, "{name} changes its offset at {last} and again at {at} ms, within two days");
                }
                last = Some(at);
                changes += 1;
                // A millisecond each side of where the clock reads each side of the change, and
                // the middle of the time it skips or repeats.
                let edges = [at + before, at + after].into_iter().flat_map(|e| [e - 1, e, e + 1]);
                for local in edges.chain([at + (before + after) / 2]) {
                    let clock = LocalDateTime::of(instant(local).unwrap(), Utc).unwrap();
                    let civil = Timestamp::from_millisecond(local).unwrap().to_zoned(TimeZone::UTC).datetime();
                    let theirs = tz.to_ambiguous_timestamp(civil).compatible().unwrap().as_millisecond();
                    let ours = clock.at(&zone).and_then(unix_millis);
                    assert_eq!(ours, Some(theirs), "{clock} in {name}");
                    let shown = theirs + i64::from(tz.to_offset(Timestamp::from_millisecond(theirs).unwrap()).seconds()) * 1000;
                    let written = LocalDateTime::of(instant(theirs).unwrap(), &zone);
                    assert_eq!(written, LocalDateTime::of(instant(shown).unwrap(), Utc), "{clock} in {name} written back");
                    checked += 1;
                }
            }
        }
        assert!(zones > 300 && changes > 10_000, "{zones} zones, {changes} changes");
        assert_eq!(checked, changes * 7);
    }

    #[test]
    fn a_bound_is_rounded_to_the_minute_an_input_steps_by() {
        for (text, down, up) in [
            ("2026-11-13T14:05", "2026-11-13T14:05", Some("2026-11-13T14:05")),
            ("2026-11-13T14:05:00.001", "2026-11-13T14:05", Some("2026-11-13T14:06")),
            ("2026-11-13T14:05:59.999", "2026-11-13T14:05", Some("2026-11-13T14:06")),
            ("2026-11-13T23:59:30", "2026-11-13T23:59", Some("2026-11-14T00:00")),
            ("2026-12-31T23:59:59.999", "2026-12-31T23:59", Some("2027-01-01T00:00")),
            ("9999-12-31T23:59:01", "9999-12-31T23:59", None),
        ] {
            let t = read(text);
            assert_eq!(t.floor_minute().to_string(), down, "{text}");
            assert_eq!(t.ceil_minute().map(|t| t.to_string()).as_deref(), up, "{text}");
        }
    }
}
