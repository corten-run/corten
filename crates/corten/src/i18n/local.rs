//! A date and time on a clock, with no zone ([`LocalDateTime`]): what
//! `<input type="datetime-local">` sends, read as the instant it names in a zone and written back.

use std::fmt::{self, Display};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{Day, Zone};
use crate::form::FormZone;
use crate::view::{quoted, AttrValue, Render};

/// Milliseconds in a day.
const DAY: i64 = 86_400_000;

/// A date and a time of day on a clock, with no zone: what `<input type="datetime-local">`
/// sends (`2026-11-13T14:05`), the time a person reads off the clock where they are. It names an
/// instant only in a zone, so it is not one. A form draws an instant as the input's `value` in a
/// [`DrawZone`](crate::form::DrawZone) (`zone.local(at)`, rounded down with
/// [`floor_minute`](LocalDateTime::floor_minute)) and its `min` and `max` with `zone.min(at)` and
/// `zone.max(at)`; the zone also writes itself into the form, and its post reads the field in
/// the zone the form sends back, a
/// [`FormZone`](crate::form::FormZone): [`at`](LocalDateTime::at) takes only that. A field the
/// user fills in is an [`Entry<LocalDateTime>`](crate::form::Entry), which keeps the text when it
/// does not read.
///
/// ```
/// use corten::prelude::*;
/// use corten::form::{DrawZone, FormZone};
/// use corten::i18n::{parse_timestamp, LocalDateTime, Offset};
///
/// #[derive(Fields)]
/// struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
///
/// let at = parse_timestamp("2026-11-13T20:05:00Z").unwrap();
/// assert_eq!(DrawZone::from(Offset::hours(-6)).local(at).unwrap().to_string(), "2026-11-13T14:05");
/// let posted: Repair = corten::form::from_bytes(b"live_at=2026-11-13T14%3A05&zone=-06%3A00").unwrap();
/// assert_eq!(posted.live_at.at(&posted.zone), Some(at));
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
/// use corten::prelude::*;
/// use corten::form::FormZone;
/// use corten::i18n::{parse_timestamp, LocalDateTime};
///
/// #[derive(Fields)]
/// struct Posted { zone: FormZone }
///
/// let chicago = corten::form::from_bytes::<Posted>(b"zone=America%2FChicago").unwrap().zone;
/// let skipped: LocalDateTime = "2026-03-08T02:30".parse().unwrap();
/// assert_eq!(skipped.at(&chicago), parse_timestamp("2026-03-08T03:30:00-05:00"));
/// let repeated: LocalDateTime = "2026-11-01T01:30".parse().unwrap();
/// assert_eq!(repeated.at(&chicago), parse_timestamp("2026-11-01T01:30:00-05:00"));
/// # }
/// ```
///
/// An instant drawn and read back is itself, except in an hour the clocks repeat: the second
/// `01:30` (`07:30Z` in Chicago) is drawn as `01:30`, which reads as the first (`06:30Z`). A form
/// that edits a stored instant reads its field with
/// [`Entry::at_keeping`](crate::form::Entry::at_keeping), which keeps the stored instant when the
/// field comes back as it was drawn.
///
/// It reads and writes HTML's syntax for a local date and time: a [`Day`], `T` (or a space) and
/// the time to the minute, with seconds and up to three digits of a second when the input's
/// `step` asks for them (`2026-11-13T14:05:09.5`). It is written as HTML normalizes one, which
/// is what a browser sends: with `T`, and with the seconds and their fraction only where they are
/// not zero. An input counts its steps (a minute unless `step` says otherwise) from its `min`,
/// else its `value`, so a `min` or a `value` with seconds or a fraction of one puts every whole
/// minute, or the value itself, off a step, and the form is not sent until the visitor picks a
/// time that is on one (`corten dev` names such a control drawn with a value). Draw each of them
/// rounded down to the minute: the `value` with [`floor_minute`](LocalDateTime::floor_minute), the
/// `min` and the `max` with [`DrawZone::min`](crate::form::DrawZone::min) and
/// [`DrawZone::max`](crate::form::DrawZone::max). Each is then on a step, and a stored instant
/// inside the handler's bounds is drawn inside the drawn ones: rounding down keeps their order (a
/// `min` rounded up would be after a stored value in the same minute, and the browser would not
/// send the form), and where the clocks go back, which puts a later instant at an earlier reading
/// (`01:45` before the change, `01:30` after it), `min` and `max` are drawn at the offset that
/// keeps every later or earlier instant inside them. The input then allows the part of a minute
/// before a `min`, up to an hour beside a bound near a change of the clocks, and a time the clocks
/// skip or repeat near a bound reads outside it (a skipped minute an hour later, a repeated one as
/// its first instant), so the handler's own comparison is the check, and refuses those with the
/// field's message.
///
/// ```
/// use corten::form::DrawZone;
/// use corten::i18n::{parse_timestamp, LocalDateTime, Utc};
///
/// let zone = DrawZone::from(Utc);
/// let listed = parse_timestamp("2026-11-12T15:30:09.250Z").unwrap();
/// let stored = parse_timestamp("2026-11-12T15:30:40Z").unwrap(); // in the same minute
/// let min = zone.min(listed).unwrap();
/// let value = zone.local(stored).map(LocalDateTime::floor_minute).unwrap();
/// assert_eq!((min.to_string(), value.to_string()), ("2026-11-12T15:30".into(), "2026-11-12T15:30".into()));
/// assert!(min <= value, "the browser sends the form unchanged");
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

    /// The minute it is in (`14:05:09` is `14:05`), for an input's `value`, `min` or `max`, which
    /// count their steps in whole minutes.
    pub fn floor_minute(self) -> Self {
        LocalDateTime { millis: self.millis - self.millis % 60_000, ..self }
    }

    /// What the clock in `zone` reads at `at`, to the millisecond (rounded down); `None` outside
    /// the years a [`Day`] has (1 to 9999). A form writes it with
    /// [`DrawZone::local`](crate::form::DrawZone::local), in the zone it sends back.
    /// `None` too past the zone's rules ([`Zone::known_offset`]), so a time is not drawn at an
    /// offset the zone does not have there.
    pub(crate) fn clock(at: SystemTime, zone: impl Zone) -> Option<Self> {
        Self::clock_at(at, zone.known_offset(at)?)
    }

    /// What a clock `offset` seconds east of UTC reads at `at`.
    fn clock_at(at: SystemTime, offset: i32) -> Option<Self> {
        let local = unix_millis(at)?.checked_add(i64::from(offset) * 1000)?;
        let day = Day::from_days(local.div_euclid(DAY))?;
        Some(LocalDateTime { day, millis: local.rem_euclid(DAY) as u32 })
    }

    /// The minute the clock in `zone` reads at `at`, or, where the clocks go back within the day
    /// after it, the minute it reads at the offset they go back to: no later than the clock reads
    /// at any instant from `at` on, so an input's `min` drawn from it is before a value drawn from
    /// any later instant, even in the hour the clocks repeat (`01:45` before the change is after
    /// `01:30` after it).
    pub(crate) fn lowest_from(at: SystemTime, zone: impl Zone) -> Option<Self> {
        let here = zone.known_offset(at)?;
        let later = at.checked_add(Duration::from_millis(DAY as u64)).and_then(|a| zone.known_offset(a));
        Self::clock_at(at, here.min(later.unwrap_or(here))).map(Self::floor_minute)
    }

    /// The minute the clock in `zone` reads at `at`, or, where the clocks went back within the day
    /// before it, the minute it read at the offset before: no earlier than the clock read at any
    /// instant up to `at`, for an input's `max`.
    pub(crate) fn highest_until(at: SystemTime, zone: impl Zone) -> Option<Self> {
        let here = zone.known_offset(at)?;
        let earlier = at.checked_sub(Duration::from_millis(DAY as u64)).and_then(|a| zone.known_offset(a));
        Self::clock_at(at, here.max(earlier.unwrap_or(here))).map(Self::floor_minute)
    }

    /// The instant this time on the clock is in the zone its form was drawn in and sent back (the
    /// form's [`FormZone`]): a skipped time moves forward by the gap, and a repeated time is the
    /// earlier instant, as the [type](LocalDateTime) says. `None` before the earliest
    /// `SystemTime` the platform has (1601-01-01 on Windows), and past the zone's rules (a tz
    /// database name past late 9999-12-30 UTC, where jiff's range ends): a time is refused, the
    /// field's message, rather than read at an offset the zone does not have there. It takes no
    /// other zone: the zone of the request that posts a form need not be the one the form was
    /// drawn in.
    ///
    /// ```compile_fail,E0308
    /// use corten::i18n::{LocalDateTime, Utc};
    ///
    /// let read: LocalDateTime = "2026-11-13T14:05".parse().unwrap();
    /// let _ = read.at(Utc); // as req.zone() would be without the `zones` feature
    /// ```
    ///
    /// Nor the request's zone with it (`req.zone()` is a `Visitor`), by value or by reference:
    ///
    #[cfg_attr(feature = "zones", doc = "```compile_fail,E0308")]
    #[cfg_attr(not(feature = "zones"), doc = "```ignore")]
    /// use corten::i18n::{LocalDateTime, Visitor};
    ///
    /// let read: LocalDateTime = "2026-11-13T14:05".parse().unwrap();
    /// let _ = read.at(Visitor::named("America/Chicago")); // as read.at(req.zone()) would be
    /// ```
    ///
    #[cfg_attr(feature = "zones", doc = "```compile_fail,E0308")]
    #[cfg_attr(not(feature = "zones"), doc = "```ignore")]
    /// use corten::i18n::{LocalDateTime, Visitor};
    ///
    /// let read: LocalDateTime = "2026-11-13T14:05".parse().unwrap();
    /// let _ = read.at(&Visitor::named("America/Chicago")); // as read.at(&req.zone()) would be
    /// ```
    ///
    /// Nor the zone a page draws in:
    ///
    /// ```compile_fail,E0308
    /// use corten::form::DrawZone;
    /// use corten::i18n::{LocalDateTime, Utc};
    ///
    /// let read: LocalDateTime = "2026-11-13T14:05".parse().unwrap();
    /// let _ = read.at(&DrawZone::from(Utc)); // as DrawZone::from(req.zone()) would be
    /// ```
    pub fn at(self, zone: &FormZone) -> Option<SystemTime> {
        self.read_in(zone)
    }

    /// [`at`](LocalDateTime::at) in any zone. It asks the zone for its offset a day before and a
    /// day after, so a zone whose offset changed twice within two days would be read with the
    /// outer two.
    pub(crate) fn read_in(self, zone: impl Zone) -> Option<SystemTime> {
        // The clock's reading as if it were UTC's; the instant is that minus the offset there.
        let local = self.day.days() * DAY + i64::from(self.millis);
        // The offset at `utc`, if the platform has that instant and the zone's rules reach it.
        let offset = |utc: i64| instant(utc).and_then(|at| zone.known_offset(at)).map(|o| i64::from(o) * 1000);
        // A day before the first instant the platform has (1601-01-01 on Windows) or the zone's
        // rules reach, or after the last, has no offset to ask for; the nearest that has one
        // stands in, as no zone changes its offset there.
        let before = offset(local - DAY).or_else(|| offset(local)).or_else(|| offset(local + DAY))?;
        let after = offset(local + DAY).or_else(|| offset(local)).or_else(|| offset(local - DAY))?;
        // Whether the clock reads `local` at the instant it gives with offset `o`.
        let holds = |o: i64| offset(local - o) == Some(o);
        // Repeated: both hold, and the offset before is the larger, so its instant is the earlier.
        // Skipped: neither holds, and the offset before moves it forward by the gap.
        let read = if holds(before) || !holds(after) { local - before } else { local - after };
        // An instant past the zone's rules is refused, not read at an offset the zone gives
        // somewhere else.
        offset(read)?;
        instant(read)
    }

    /// The first instant whose clock in `zone` reads this time or later: where the clock reads
    /// it, [`read_in`](LocalDateTime::read_in)'s (the earlier of a repeated time), and where the
    /// clocks skip it, the change itself rather than the instant the gap moves it to, as Temporal's
    /// `startOfDay` (`GetStartOfDay`) gives a day whose midnight is skipped. Toronto's clocks
    /// went from `23:30` to `00:30` at 1919-03-31T04:30Z: `00:00` reads as 05:00Z, and the day
    /// began at 04:30Z.
    pub(super) fn first_reading(self, zone: impl Zone) -> Option<SystemTime> {
        let read = unix_millis(self.read_in(&zone)?)?;
        let local = self.day.days() * DAY + i64::from(self.millis);
        // What the clock reads at `utc`, in milliseconds as if it were UTC's.
        let shown = |utc: i64| Some(utc + i64::from(zone.known_offset(instant(utc)?)?) * 1000);
        let gap = shown(read)? - local;
        if gap <= 0 {
            return instant(read);
        }
        // Skipped: `read` is `gap` after the instant the offset before gives, which the clock
        // shows before `local`; from the change on it shows `local` or later. The change is the
        // first millisecond that does.
        let (mut earlier, mut later) = (read - gap, read);
        while later - earlier > 1 {
            let mid = earlier + (later - earlier) / 2;
            if shown(mid)? >= local {
                later = mid;
            } else {
                earlier = mid;
            }
        }
        instant(later)
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
impl LocalDateTime {
    /// HTML's normalized form, written digit by digit: an input draws up to three (`value`,
    /// `min`, `max`), and through `write!` each took about 1,700 instructions (callgrind).
    fn write_into(self, out: &mut String) {
        let (year, month, day) = super::format::civil_from_days(self.day.days());
        // `year` is 1 to 9999, as a `Day`'s is.
        digits(out, year as u32, 4);
        out.push('-');
        digits(out, month, 2);
        out.push('-');
        digits(out, day, 2);
        out.push('T');
        digits(out, self.hour(), 2);
        out.push(':');
        digits(out, self.minute(), 2);
        let (second, ms) = (self.second(), self.millisecond());
        if second != 0 || ms != 0 {
            out.push(':');
            digits(out, second, 2);
        }
        if ms != 0 {
            out.push('.');
            match ms {
                _ if ms.is_multiple_of(100) => digits(out, ms / 100, 1),
                _ if ms.is_multiple_of(10) => digits(out, ms / 10, 2),
                _ => digits(out, ms, 3),
            }
        }
    }
}

/// `n` in `width` digits, with leading zeros.
fn digits(out: &mut String, n: u32, width: u32) {
    for place in (0..width).rev() {
        out.push(char::from(b'0' + (n / 10u32.pow(place) % 10) as u8));
    }
}

impl Display for LocalDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut text = String::with_capacity(23);
        self.write_into(&mut text);
        f.write_str(&text)
    }
}

impl fmt::Debug for LocalDateTime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LocalDateTime({self})")
    }
}

impl Render for LocalDateTime {
    fn render(&self, out: &mut String) {
        self.write_into(out);
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
            let local = LocalDateTime::clock(at, zone).unwrap();
            assert_eq!(local.to_string(), written);
            assert_eq!(local.read_in(zone), Some(at), "{written} reads back as the instant");
        }
        assert_eq!(LocalDateTime::clock(at, Utc).unwrap().to_string(), "2026-11-13T20:05:09.25");
        // Before 1970 it rounds down too, so the clock reads what it read a moment before.
        let before = UNIX_EPOCH - Duration::from_nanos(1);
        assert_eq!(LocalDateTime::clock(before, Utc).unwrap().to_string(), "1969-12-31T23:59:59.999");
        assert_eq!(read("1969-12-31T23:59:59.999").read_in(Utc), Some(UNIX_EPOCH - Duration::from_millis(1)));
        // A day reads only within the years a Day has.
        assert_eq!(LocalDateTime::clock(parse_timestamp("9999-12-31T23:00:00Z").unwrap(), Offset::hours(2)), None);
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
            assert_eq!(read(local).read_in(&zone), Some(ts(instant)), "{local}");
        }
        // An instant reads back as the clock showed it, the second 01:30 included.
        assert_eq!(LocalDateTime::clock(ts("2026-11-01T07:30:00Z"), &zone).unwrap().to_string(), "2026-11-01T01:30");
        assert_eq!(LocalDateTime::clock(ts("2026-03-08T08:00:00Z"), &zone).unwrap().to_string(), "2026-03-08T03:00");
    }

    /// Where the clocks go back, a later instant reads earlier on the clock (`01:45` before the
    /// change, `01:30` after it), so bounds drawn at their own instants' readings would be out of
    /// order with a value between them, and the browser would not send the form unchanged.
    #[test]
    fn bounds_hold_every_value_between_them_where_the_clocks_go_back() {
        let ts = |text: &str| parse_timestamp(text).unwrap();
        let secs = |text: &str| unix_millis(ts(text)).unwrap() / 1000;
        // Clocks go from 02:00 back to 01:00 at 07:00Z.
        let zone = Changes(vec![(0, -5 * 3600), (secs("2026-11-01T07:00:00Z"), -6 * 3600)]);
        let shown = |at| LocalDateTime::clock(at, &zone).unwrap().floor_minute();
        let (listed, stored, now) = (ts("2026-11-01T06:45:00Z"), ts("2026-11-01T07:30:00Z"), ts("2026-11-01T07:40:00Z"));
        let value = shown(stored);
        assert_eq!(
            (shown(listed).to_string(), value.to_string(), shown(now).to_string()),
            ("2026-11-01T01:45".into(), "2026-11-01T01:30".into(), "2026-11-01T01:40".into()),
            "at their own readings the bounds are out of order with the value"
        );
        let (min, max) = (LocalDateTime::lowest_from(listed, &zone).unwrap(), LocalDateTime::highest_until(now, &zone).unwrap());
        assert_eq!((min.to_string(), max.to_string()), ("2026-11-01T00:45".into(), "2026-11-01T02:40".into()));
        assert!(min <= value && value <= max, "{min} <= {value} <= {max}");
        // Within the day before the change a `min` is drawn at the offset after it, an hour
        // earlier; away from a change, bounds are the instant's own reading.
        let day_before = ts("2026-10-31T12:00:09Z");
        assert_eq!(LocalDateTime::lowest_from(day_before, &zone).map(|m| m.to_string()), Some("2026-10-31T06:00".into()));
        assert_eq!(LocalDateTime::highest_until(day_before, &zone), Some(shown(day_before)));
        let july = ts("2026-07-01T12:00:09Z");
        assert_eq!(LocalDateTime::lowest_from(july, &zone), Some(shown(july)));
        assert_eq!(LocalDateTime::highest_until(july, &zone), Some(shown(july)));
    }

    /// jiff's range ends late on 9999-12-30 UTC. A tz database zone past it is refused, drawn as
    /// nothing and read as no instant, rather than taken as UTC; a fixed offset has no range.
    #[cfg(feature = "zones")]
    #[test]
    fn a_tz_database_zone_draws_and_reads_only_where_its_rules_reach() {
        use crate::form::{DrawZone, FormZone};
        use crate::i18n::Visitor;
        let (max, hour) = (SystemTime::from(jiff::Timestamp::MAX), Duration::from_secs(3600));
        let (fixed, named) = (Offset::hours(-6), Visitor::named("Etc/GMT+6"));
        let draw = DrawZone::from(named.clone());
        let posted = FormZone::read("Etc/GMT+6").expect("Etc/GMT+6 is sent and read back");
        // Inside the range: as the fixed offset draws and reads.
        let inside = max - hour;
        assert!(LocalDateTime::clock(inside, fixed).is_some());
        assert_eq!(draw.local(inside), LocalDateTime::clock(inside, fixed));
        assert_eq!(draw.min(inside), LocalDateTime::lowest_from(inside, fixed));
        let shown = LocalDateTime::clock(inside, fixed).unwrap().floor_minute();
        assert!(shown.at(&posted).is_some());
        assert_eq!(shown.at(&posted), shown.read_in(fixed));
        // Past it: nothing, where the zone's offset was taken as UTC's.
        let past = max + hour;
        assert_eq!(draw.local(past), None);
        assert_eq!((draw.min(past), draw.max(past)), (None, None));
        let late = LocalDateTime::clock(past, fixed).unwrap();
        assert!(late.read_in(fixed).is_some(), "an offset has no range");
        assert_eq!(late.at(&posted), None);
        assert_eq!(read("9999-12-31T23:00").at(&posted), None);
        assert_eq!(Day::new(9999, 12, 31).unwrap().start(&posted), None);
        // A date written past it is still written at UTC's offset, as before.
        assert_eq!(named.offset(past), 0);
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
        // A gap that starts the day before: 23:30 to 00:30 at 04:30Z, as Toronto's clocks went on
        // 1919-03-31. The day begins at the change, though `00:00` typed into a form moves forward
        // by the gap to 01:00; and a repeat that starts after midnight, 00:30 back to 23:30 at
        // 04:30Z, begins the day at its first midnight.
        let zone = Changes(vec![
            (secs("1900-01-01T00:00:00Z"), -5 * 3600),
            (secs("1919-03-31T04:30:00Z"), -4 * 3600),
            (secs("1919-10-27T04:30:00Z"), -5 * 3600),
        ]);
        assert_eq!(Day::new(1919, 3, 31).unwrap().start(&zone), Some(ts("1919-03-31T04:30:00Z")));
        assert_eq!(read("1919-03-31T00:00").read_in(&zone), Some(ts("1919-03-31T05:00:00Z")));
        assert_eq!(read("1919-03-31T00:00").first_reading(&zone), Some(ts("1919-03-31T04:30:00Z")));
        assert_eq!(read("1919-03-31T00:15").first_reading(&zone), Some(ts("1919-03-31T04:30:00Z")));
        assert_eq!(read("1919-03-31T00:45").first_reading(&zone), Some(ts("1919-03-31T04:45:00Z")));
        assert_eq!(Day::new(1919, 3, 30).unwrap().start(&zone), Some(ts("1919-03-30T05:00:00Z")));
        assert_eq!(Day::new(1919, 4, 1).unwrap().start(&zone), Some(ts("1919-04-01T04:00:00Z")));
        assert_eq!(Day::new(1919, 10, 27).unwrap().start(&zone), Some(ts("1919-10-27T04:00:00Z")));
        assert_eq!(Day::new(1919, 10, 28).unwrap().start(&zone), Some(ts("1919-10-28T05:00:00Z")));
    }

    /// `day.start(Utc)` is the day's midnight UTC wherever the platform has that instant, as
    /// `midnight_utc` gave, even where it lacks the day before (1601-01-01 is Windows' first day)
    /// or the day after; and in a zone behind UTC as well.
    #[test]
    fn a_day_starts_at_midnight_utc_on_the_platforms_first_and_last_days() {
        for (y, m, d) in [(1, 1, 1), (1601, 1, 1), (1601, 1, 2), (1970, 1, 1), (9999, 12, 31)] {
            let day = Day::new(y, m, d).unwrap();
            assert_eq!(day.start(Utc), instant(day.days() * DAY), "{y}-{m}-{d}");
            let west = instant(day.days() * DAY + 6 * 3_600_000);
            assert_eq!(day.start(Offset::hours(-6)), west, "{y}-{m}-{d} at -06:00");
        }
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
            assert_eq!(read(local).read_in(Visitor::named(zone)), Some(ts(instant)), "{local} in {zone}");
        }
        // Sao Paulo moved its clocks at midnight: the day began at 01:00.
        let sao_paulo = Visitor::named("America/Sao_Paulo");
        assert_eq!(Day::new(2018, 11, 4).unwrap().start(&sao_paulo), Some(ts("2018-11-04T01:00:00-02:00")));
        assert_eq!(Day::new(2019, 2, 17).unwrap().start(&sao_paulo), Some(ts("2019-02-17T00:00:00-03:00")));
        // Toronto's clocks went from 23:30 to 00:30 at 04:30Z (tz database, northamerica): the day
        // began at the change, half an hour before `00:00` read as a typed time (01:00, 05:00Z).
        let toronto = Visitor::named("America/Toronto");
        assert_eq!(Day::new(1919, 3, 31).unwrap().start(&toronto), Some(ts("1919-03-31T04:30:00Z")));
        // A millisecond before that change is still before it, though jiff looks an instant before
        // 1970 up by its second toward zero, the change's own.
        let change = ts("1919-03-31T04:30:00Z");
        assert_eq!(toronto.known_offset(change - Duration::from_millis(1)), Some(-5 * 3600));
        assert_eq!(toronto.known_offset(change), Some(-4 * 3600));
        assert_eq!(read("1919-03-31T00:00").read_in(&toronto), Some(ts("1919-03-31T05:00:00Z")));
        assert_eq!(LocalDateTime::clock(ts("2026-11-15T09:00:00Z"), &sao_paulo).unwrap().to_string(), "2026-11-15T06:00");
    }

    /// In every zone in the bundled tz database, the day before each change of offset from the
    /// zone's first (its local mean time) to 2040, the days it changes and the day after start
    /// where Temporal's `startOfDay` starts them: the earlier midnight, or, where the clocks skip
    /// midnight, the change, found in the database by jiff. Unlike the comparison below, it does
    /// not need a zone's changes to be two days apart, and reaches back before 1970, where gaps
    /// that start the day before and cross midnight are (Toronto's in 1919).
    #[cfg(feature = "zones")]
    #[test]
    fn every_day_around_every_change_starts_where_temporal_starts_it() {
        use crate::i18n::Visitor;
        use jiff::tz::{AmbiguousOffset, TimeZone};
        use jiff::Timestamp;
        let until = Timestamp::from_second(2_208_988_800).unwrap(); // 2040
        let ms = |ms: i64| Timestamp::from_millisecond(ms).unwrap();
        let (mut days, mut skipped, mut crossing) = (0, 0, 0);
        for name in jiff::tz::db().available() {
            let name = name.as_str();
            let (tz, zone) = (TimeZone::get(name).unwrap(), Visitor::named(name));
            for change in tz.following(Timestamp::MIN).take_while(|c| c.timestamp() < until) {
                let at = change.timestamp().as_millisecond();
                // A second before: jiff looks an instant before 1970 up by its second toward zero.
                let before = i64::from(tz.to_offset(ms(at - 1000)).seconds()) * 1000;
                let after = i64::from(change.offset().seconds()) * 1000;
                let (first, last) = ((at + before.min(after)).div_euclid(DAY) - 1, (at + before.max(after)).div_euclid(DAY) + 1);
                for d in first..=last {
                    let Some(day) = Day::from_days(d) else { continue };
                    let midnight = ms(d * DAY).to_zoned(TimeZone::UTC).datetime();
                    let ambiguous = tz.to_ambiguous_timestamp(midnight);
                    let theirs = match ambiguous.offset() {
                        AmbiguousOffset::Gap { before, after } => {
                            // The change to the offset after, the first after midnight read at it.
                            let from = d * DAY - i64::from(after.seconds()) * 1000;
                            let change = tz.following(ms(from)).find(|c| c.offset() == after).unwrap();
                            let change = change.timestamp().as_millisecond();
                            skipped += 1;
                            crossing += usize::from(change + i64::from(before.seconds()) * 1000 < d * DAY);
                            change
                        }
                        _ => ambiguous.earlier().unwrap().as_millisecond(),
                    };
                    assert_eq!(day.start(&zone).and_then(unix_millis), Some(theirs), "{day} in {name}");
                    days += 1;
                }
            }
        }
        assert!(
            days > 30_000 && skipped > 100 && crossing > 0,
            "{days} days, {skipped} skipped midnights, {crossing} from the day before"
        );
    }

    /// In every zone in the bundled tz database, around every change of offset from 1970 to 2040,
    /// `at` gives the instant jiff's `compatible()` gives (Temporal's default) and `clock` reads it
    /// back as jiff's clock does; no zone changes its offset twice within two days, which `at`'s
    /// reading a day either side relies on; an input's `min` and `max` drawn around the change
    /// hold every value drawn between them; and every zone is sent with a form by a name its post
    /// reads back as the same zone.
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
            // A form drawn in it sends it by a name its post reads back.
            let drawn = crate::form::DrawZone::from(Visitor::named(name));
            let posted = crate::form::FormZone::read(drawn.name());
            assert_eq!(posted.as_ref().map(crate::form::DrawZone::from), Some(drawn), "{name} sent and read back");
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
                    let clock = LocalDateTime::clock(instant(local).unwrap(), Utc).unwrap();
                    let civil = Timestamp::from_millisecond(local).unwrap().to_zoned(TimeZone::UTC).datetime();
                    let theirs = tz.to_ambiguous_timestamp(civil).compatible().unwrap().as_millisecond();
                    let ours = clock.read_in(&zone).and_then(unix_millis);
                    assert_eq!(ours, Some(theirs), "{clock} in {name}");
                    let shown = theirs + i64::from(tz.to_offset(Timestamp::from_millisecond(theirs).unwrap()).seconds()) * 1000;
                    let written = LocalDateTime::clock(instant(theirs).unwrap(), &zone);
                    assert_eq!(written, LocalDateTime::clock(instant(shown).unwrap(), Utc), "{clock} in {name} written back");
                    checked += 1;
                }
                // A `min` and a `max` drawn from instants around the change hold every value
                // drawn from an instant between them, in order.
                let near = [-2 * 3_600_000, -1_800_000, -1, 0, 1_800_000, 2 * 3_600_000].map(|d| instant(at + d).unwrap());
                let drawn = near.map(|t| {
                    let value = LocalDateTime::clock(t, &zone).unwrap().floor_minute();
                    (LocalDateTime::lowest_from(t, &zone).unwrap(), value, LocalDateTime::highest_until(t, &zone).unwrap())
                });
                for i in 0..drawn.len() {
                    for j in i..drawn.len() {
                        let ((min, earlier, _), (_, later, max)) = (drawn[i], drawn[j]);
                        assert!(min <= later && earlier <= max, "{name}: min {min} or max {max} around {at} ms");
                    }
                }
            }
        }
        assert!(zones > 300 && changes > 10_000, "{zones} zones, {changes} changes");
        assert_eq!(checked, changes * 7);
    }

    #[test]
    fn a_time_is_drawn_to_the_minute_an_input_steps_by() {
        for (text, down) in [
            ("2026-11-13T14:05", "2026-11-13T14:05"),
            ("2026-11-13T14:05:00.001", "2026-11-13T14:05"),
            ("2026-11-13T14:05:59.999", "2026-11-13T14:05"),
            ("2026-12-31T23:59:59.999", "2026-12-31T23:59"),
            ("9999-12-31T23:59:01", "9999-12-31T23:59"),
        ] {
            assert_eq!(read(text).floor_minute().to_string(), down, "{text}");
        }
        // Rounding down keeps the order, so a stored time is never drawn before a bound it was
        // after, even in the bound's own minute.
        let (bound, stored) = (read("2026-11-13T14:05:09.250"), read("2026-11-13T14:05:40"));
        assert!(bound.floor_minute() <= stored.floor_minute());
    }
}
