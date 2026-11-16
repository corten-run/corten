//! The zone a form's dates and times are drawn in ([`DrawZone`]), and the same zone sent back
//! with the form for its post to read them in ([`FormZone`]).

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::form::FieldName;
use crate::i18n::{LocalDateTime, Offset, Utc, Zone};
use crate::view::{escape_into, Render};

/// The zone a form's dates and times are drawn in: it writes the hidden input that sends the
/// zone back with the form ([`field`](DrawZone::field)), the zone's name for the visitor to read
/// ([`name`](DrawZone::name)), and an instant as the `value`, `min` or `max` of an
/// `<input type="datetime-local">` ([`local`](DrawZone::local)), so the three are in one zone.
/// The post reads the form's times in the [`FormZone`] it sends back, never in the zone of the
/// request that posts it: `req.zone()` is UTC on a browser's first page and in a `Public` page, and
/// the visitor's own zone on the post after it, so a form drawn in one and read in the other would
/// store a time moved by the visitor's offset, with nothing to say so.
///
/// It is made from the request's zone (`DrawZone::from(req.zone())`, with the `zones` feature),
/// from [`Utc`] (a `Public` page, which is the same for everyone) or an [`Offset`], and, for a form
/// drawn again after a refused post, from the zone that post sent (`DrawZone::from(&input.zone)`),
/// so the times the visitor typed stay in the zone they typed them in. It is sent as the name the
/// visitor reads it by: `UTC`, an offset (`-06:00`), or a tz database name (`America/Chicago`).
///
/// Show [`name`](DrawZone::name) with the form's dates and times: without JavaScript a browser
/// never reports its zone, so they are drawn and read in UTC, and a visitor types a time in UTC
/// only if the page says so.
///
/// ```
/// use corten::prelude::*;
/// use corten::form::{DrawZone, Entry, FormZone};
/// use corten::i18n::{parse_timestamp, LocalDateTime, Offset};
///
/// #[derive(Fields)]
/// struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
///
/// // In a handler, DrawZone::from(req.zone()).
/// let zone = DrawZone::from(Offset::hours(-6));
/// let listed = parse_timestamp("2026-11-12T15:30:09Z").unwrap();
/// let f = Repair::FIELDS;
/// let form = html! {
///     <form method="post">
///         {zone.field(f.zone)}
///         <label>"Goes live (" {zone.name()} ")"
///             <input type="datetime-local" name={f.live_at}
///                 min={zone.min(listed)}>
///         </label>
///     </form>
/// };
/// let html = form.to_html();
/// assert!(html.contains(r#"<input type="hidden" name="zone" value="-06:00">"#), "{html}");
/// assert!(html.contains("Goes live (-06:00)") && html.contains(r#"min="2026-11-12T09:30""#), "{html}");
///
/// // The post reads in the zone the form came back with, whatever zone its request is in,
/// let posted: Repair = corten::form::from_bytes(b"live_at=2026-11-13T14%3A05&zone=-06%3A00").unwrap();
/// assert_eq!(posted.live_at.at(&posted.zone), parse_timestamp("2026-11-13T20:05:00Z"));
/// // and a form drawn again after a refusal is drawn in it.
/// assert_eq!(DrawZone::from(&posted.zone).name(), "-06:00");
/// ```
///
/// Every instant is drawn to the minute, the stored `value` with
/// [`LocalDateTime::floor_minute`], the `min` and the `max` with [`min`](DrawZone::min) and
/// [`max`](DrawZone::max): an input counts its steps (a minute) from its `min`, so one with seconds
/// is off every step, and the browser does not send the form until the visitor changes it.
/// Rounding all of them down keeps their order, so a stored instant in the same minute as its
/// `min` is not drawn before it; and `min` and `max` are drawn at the offset that keeps them
/// outside every value an instant between them is drawn as, where the clocks go back (a `min` at
/// `01:45` before the change would be after a value of `01:30` after it). The post reads an
/// edited field with
/// [`Entry::at_keeping`](crate::form::Entry::at_keeping), which keeps the stored instant when the
/// field comes back as it was drawn, so an unchanged field is not moved to its minute, nor, in an
/// hour the clocks repeat, to the first of the two (the second `01:30` is drawn as `01:30`, which
/// reads as the first):
///
/// ```
/// # use corten::prelude::*;
/// # use corten::form::{DrawZone, Entry, FormZone};
/// # use corten::i18n::{parse_timestamp, LocalDateTime, Utc};
/// # #[derive(Fields)]
/// # struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
/// let listed = parse_timestamp("2026-11-13T20:05:01Z").unwrap();
/// let stored = parse_timestamp("2026-11-13T20:05:09.250Z").unwrap();
/// let zone = DrawZone::from(Utc);
/// let min = zone.min(listed);
/// let shown = zone.local(stored).map(LocalDateTime::floor_minute);
/// assert!(min <= shown, "the browser sends it unchanged");
/// assert_eq!(shown.unwrap().to_string(), "2026-11-13T20:05");
///
/// // The post: sent back as it was drawn, it is the stored instant.
/// let same: Repair = corten::form::from_bytes(b"live_at=2026-11-13T20%3A05&zone=UTC").unwrap();
/// assert_eq!(same.live_at.at_keeping(&same.zone, stored), Some(stored));
/// let moved: Repair = corten::form::from_bytes(b"live_at=2026-11-13T20%3A06&zone=UTC").unwrap();
/// assert_eq!(moved.live_at.at_keeping(&moved.zone, stored), parse_timestamp("2026-11-13T20:06:00Z"));
/// ```
///
/// [`field`](DrawZone::field) takes only a `FormZone` field's name:
///
/// ```compile_fail,E0308
/// use corten::prelude::*;
/// use corten::form::{DrawZone, Entry, FormZone};
/// use corten::i18n::{LocalDateTime, Utc};
///
/// #[derive(Fields)]
/// struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
///
/// let _ = DrawZone::from(Utc).field(Repair::FIELDS.live_at);
/// ```
///
/// The compiler checks that a posted time is read only in a `FormZone`, that a `FormZone` is made
/// only by deserializing what a client sent (a form, a query), never from a zone, that the hidden
/// input is a `FormZone` field, and that an instant is written
/// as a field's time only through a `DrawZone`. It does not check that the form draws the hidden
/// input (a form without it compiles, and its post is a 422), that the input and the times are
/// drawn from the same `DrawZone`, nor that a form drawn again is drawn in the posted zone rather
/// than the request's.
#[derive(Clone, PartialEq, Eq)]
pub struct DrawZone(Named);

/// The zone a form was drawn in, as its post sends it back (the hidden input
/// [`DrawZone::field`] writes): the only zone a posted date and time is read in
/// ([`Entry::at`](crate::form::Entry::at), [`LocalDateTime::at`]), and, for a day the visitor
/// picked, where it begins ([`Day::start`](crate::i18n::Day::start), `day.start(&input.zone)`).
/// It is made only by deserializing what a client sent (a form's post, a query, JSON), never from
/// a zone, so the zone of the request that posts it cannot stand in for it.
///
/// A zone that is none a [`DrawZone`] writes is a 422 naming the field, as any typed field a page
/// writes itself: it came from no page of the app's. So is a post without it, and UTC written as
/// an offset (`+00:00`), which a `DrawZone` writes as `UTC`: one zone is sent one way.
///
/// ```
/// # use corten::prelude::*;
/// # use corten::form::{Entry, FormZone};
/// # use corten::i18n::LocalDateTime;
/// # #[derive(Fields)]
/// # struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
/// for zone in ["", "Mars%2FOlympus", "%2B25%3A00", "%2B00%3A00", "-6", "utc"] {
///     let body = format!("live_at=2026-11-13T14%3A05&zone={zone}");
///     assert!(corten::form::from_bytes::<Repair>(body.as_bytes()).is_err(), "{zone}");
/// }
/// assert!(corten::form::from_bytes::<Repair>(b"live_at=2026-11-13T14%3A05").is_err(), "not sent");
/// ```
///
/// It cannot be made from a zone, the request's included:
///
/// ```compile_fail,E0277
/// use corten::form::FormZone;
/// use corten::i18n::Utc;
///
/// let _ = FormZone::from(Utc); // as FormZone::from(req.zone()) would be
/// ```
#[derive(Clone, PartialEq, Eq)]
pub struct FormZone(Named);

/// A zone by the name it is sent as.
#[derive(Clone)]
struct Named {
    /// As sent and shown: `UTC`, `-06:00`, `America/Chicago`.
    name: Box<str>,
    rules: Rules,
}

#[derive(Clone)]
enum Rules {
    Fixed(i32),
    #[cfg(feature = "zones")]
    Named(crate::i18n::Visitor),
}

/// The largest offset a zone is written with, 23:59, in seconds: Temporal's offsets are less than
/// a day.
const MOST: i32 = 24 * 3600 - 60;

impl Named {
    fn utc() -> Self {
        Named { name: "UTC".into(), rules: Rules::Fixed(0) }
    }

    /// The zone `text` names, as a [`DrawZone`] writes one.
    fn read(text: &str) -> Option<Self> {
        if text == "UTC" {
            return Some(Named::utc());
        }
        // UTC is sent as `UTC`, never `+00:00`.
        if let Some(east) = read_offset(text).filter(|east| *east != 0) {
            return Some(Named::offset(east));
        }
        // Only as the database writes it (jiff finds `america/chicago` too), so one zone is
        // sent one way, the way `field` draws it.
        #[cfg(feature = "zones")]
        if crate::client::zone_name(text) {
            let zone = crate::i18n::Visitor::named(text);
            if zone.name() == Some(text) {
                return Some(Named { name: text.into(), rules: Rules::Named(zone) });
            }
        }
        None
    }

    /// `east` seconds east of UTC, taken to the minute toward zero and to at most 23:59.
    fn offset(east: i32) -> Self {
        let east = (east / 60 * 60).clamp(-MOST, MOST);
        if east == 0 {
            return Named::utc();
        }
        let (sign, s) = (if east < 0 { '-' } else { '+' }, east.unsigned_abs());
        Named { name: format!("{sign}{:02}:{:02}", s / 3600, s / 60 % 60).into(), rules: Rules::Fixed(east) }
    }
}

impl Zone for Named {
    fn offset(&self, at: SystemTime) -> i32 {
        match &self.rules {
            Rules::Fixed(east) => {
                let _ = at;
                *east
            }
            #[cfg(feature = "zones")]
            Rules::Named(zone) => zone.offset(at),
        }
    }

    fn known_offset(&self, at: SystemTime) -> Option<i32> {
        match &self.rules {
            Rules::Fixed(east) => {
                let _ = at;
                Some(*east)
            }
            #[cfg(feature = "zones")]
            Rules::Named(zone) => zone.known_offset(at),
        }
    }
}

impl PartialEq for Named {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

impl Eq for Named {}

/// `+HH:MM` or `-HH:MM`, as Temporal writes an offset zone: seconds east of UTC.
fn read_offset(text: &str) -> Option<i32> {
    let b = text.as_bytes();
    let sign = match b.first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let two = |at: usize| -> Option<i32> {
        let d = b.get(at..at + 2)?;
        d.iter().all(u8::is_ascii_digit).then(|| i32::from(d[0] - b'0') * 10 + i32::from(d[1] - b'0'))
    };
    let (hours, minutes) = (two(1)?, two(4)?);
    (b.len() == 6 && b[3] == b':' && hours < 24 && minutes < 60).then(|| sign * (hours * 3600 + minutes * 60))
}

impl DrawZone {
    /// The hidden input that sends this zone back with the form, as its [`FormZone`] field:
    /// `<input type="hidden" name="zone" value="America/Chicago">`.
    pub fn field(&self, name: FieldName<FormZone>) -> ZoneField<'_> {
        ZoneField { name: name.untyped(), zone: &self.0.name }
    }

    /// Its name, as sent and for the visitor to read with the form's dates and times: `UTC`, an
    /// offset (`+05:30`), or a tz database name (`America/Chicago`).
    pub fn name(&self) -> &str {
        &self.0.name
    }

    /// What the clock in this zone reads at `at`, to the millisecond (rounded down): the `value`,
    /// `min` or `max` of an `<input type="datetime-local">`. Round each down to the minute the
    /// input steps by ([`LocalDateTime::floor_minute`]). `None` outside the years a
    /// [`Day`](crate::i18n::Day) has (1 to 9999).
    pub fn local(&self, at: impl Into<SystemTime>) -> Option<LocalDateTime> {
        LocalDateTime::clock(at.into(), &self.0)
    }

    /// An instant as the input's `min`: the minute this zone's clock reads at `at`, or, where the
    /// clocks go back within the day after it, the minute it reads at the offset they go back to.
    /// A clock that goes back reads `01:45` before the change and `01:30` after it, so a `min`
    /// drawn at `at`'s own reading would be after the value of an instant later than `at`, and
    /// the browser would not send the form; drawn this way it is no later than the clock reads
    /// at any instant from `at` on. The input then allows up to the hour before `at` near such a
    /// change, which the handler's own comparison refuses. `None` where
    /// [`local`](DrawZone::local) is.
    pub fn min(&self, at: impl Into<SystemTime>) -> Option<LocalDateTime> {
        LocalDateTime::lowest_from(at.into(), &self.0)
    }

    /// An instant as the input's `max`, as [`min`](DrawZone::min) draws a `min`: the minute the
    /// clock reads at `at`, or, where the clocks went back within the day before it, the minute it
    /// read at the offset before, no earlier than the clock read at any instant up to `at`.
    pub fn max(&self, at: impl Into<SystemTime>) -> Option<LocalDateTime> {
        LocalDateTime::highest_until(at.into(), &self.0)
    }
}

/// `UTC`: a `Public` page, which is the same for everyone, or an app that does not learn its
/// visitors' zones.
impl From<Utc> for DrawZone {
    fn from(_: Utc) -> Self {
        DrawZone(Named::utc())
    }
}

/// Named by its offset (`-06:00`, `+05:30`), `UTC` for none. An offset zone is to the minute and
/// less than a day, as Temporal's are, so one with seconds is taken to the minute toward zero and
/// one of a day or more (which no zone has) to 23:59; the form is drawn and read at the offset it
/// names.
impl From<Offset> for DrawZone {
    fn from(offset: Offset) -> Self {
        DrawZone(Named::offset(offset.offset(UNIX_EPOCH)))
    }
}

/// The visitor's zone (`req.zone()`), by its tz database name; `UTC` when it is not known
/// (no JavaScript, a browser's first page, a `Public` page).
#[cfg(feature = "zones")]
impl From<crate::i18n::Visitor> for DrawZone {
    fn from(zone: crate::i18n::Visitor) -> Self {
        match zone.name() {
            Some(name) if name != "UTC" => DrawZone(Named { name: name.into(), rules: Rules::Named(zone) }),
            _ => DrawZone(Named::utc()),
        }
    }
}

/// The zone a refused post sent, to draw its form again in.
impl From<&FormZone> for DrawZone {
    fn from(posted: &FormZone) -> Self {
        DrawZone(posted.0.clone())
    }
}

impl FormZone {
    /// The zone `text` names, as a [`DrawZone`] writes one: what its `Deserialize` reads.
    pub(crate) fn read(text: &str) -> Option<FormZone> {
        Named::read(text).map(FormZone)
    }
}

/// Where a day the visitor picked begins (`day.start(&input.zone)`), and any other instant the
/// form's zone gives.
impl Zone for FormZone {
    fn offset(&self, at: SystemTime) -> i32 {
        self.0.offset(at)
    }

    fn known_offset(&self, at: SystemTime) -> Option<i32> {
        self.0.known_offset(at)
    }
}

impl fmt::Debug for DrawZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DrawZone({})", self.0.name)
    }
}

impl fmt::Debug for FormZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FormZone({})", self.0.name)
    }
}

/// Its name, as it is sent.
impl fmt::Display for DrawZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.name)
    }
}

/// Its name, as it was sent.
impl fmt::Display for FormZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.name)
    }
}

impl<'de> serde::Deserialize<'de> for FormZone {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <std::borrow::Cow<'de, str>>::deserialize(deserializer)?;
        FormZone::read(&text).ok_or_else(|| {
            serde::de::Error::custom(
                "a form's zone is the one its page drew it in: UTC, an offset (+05:30) or a tz database name (America/Chicago)",
            )
        })
    }
}

/// [`DrawZone::field`]'s hidden input.
pub struct ZoneField<'a> {
    name: FieldName,
    zone: &'a str,
}

impl Render for ZoneField<'_> {
    fn render(&self, out: &mut String) {
        out.push_str(r#"<input type="hidden" name=""#);
        self.name.render(out);
        out.push_str(r#"" value=""#);
        escape_into(self.zone, out);
        out.push_str(r#"">"#);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zone_is_sent_as_its_name_and_read_back_from_it() {
        for (zone, name) in [
            (DrawZone::from(Utc), "UTC"),
            (DrawZone::from(Offset::hours(0)), "UTC"),
            (DrawZone::from(Offset::hours(-6)), "-06:00"),
            (DrawZone::from(Offset::seconds(5 * 3600 + 1800)), "+05:30"),
            (DrawZone::from(Offset::seconds(-(3600 + 60 + 1))), "-01:01"),
            (DrawZone::from(Offset::hours(14)), "+14:00"),
            // No zone is a day or more from UTC: the largest offset written is 23:59.
            (DrawZone::from(Offset::hours(30)), "+23:59"),
            (DrawZone::from(Offset::seconds(-24 * 3600)), "-23:59"),
            (DrawZone::from(Offset::seconds(i32::MIN)), "-23:59"),
        ] {
            assert_eq!(zone.name(), name);
            let read = FormZone::read(name).unwrap_or_else(|| panic!("{name} reads back"));
            assert_eq!((read.to_string(), read.offset(UNIX_EPOCH)), (name.to_string(), zone.0.offset(UNIX_EPOCH)), "{name}");
            assert_eq!(DrawZone::from(&read), zone, "{name} is drawn again as it was");
        }

        assert_eq!(DrawZone::from(Offset::seconds(-(3600 + 60 + 1))).0.offset(UNIX_EPOCH), -3660, "to the minute");
        for text in [
            "",
            "utc",
            "Z",
            "+5:30",
            "+05:3",
            "+0530",
            "05:30",
            "+24:00",
            "+30:00",
            "+00:00",
            "-00:00",
            "+05:60",
            "+05:30:15",
            "+05:30:0",
            "Mars/Olympus",
        ] {
            assert!(FormZone::read(text).is_none(), "{text:?}");
        }
        let mut out = String::new();
        DrawZone::from(Offset::hours(-6)).field(FieldName::__new("zone")).render(&mut out);
        assert_eq!(out, r#"<input type="hidden" name="zone" value="-06:00">"#);
    }

    #[cfg(feature = "zones")]
    #[test]
    fn the_visitors_zone_is_sent_by_its_tz_database_name() {
        use crate::i18n::Visitor;
        use std::time::Duration;
        let chicago = DrawZone::from(Visitor::named("America/Chicago"));
        let july = UNIX_EPOCH + Duration::from_secs(1_783_000_000);
        assert_eq!((chicago.name(), chicago.0.offset(july)), ("America/Chicago", -5 * 3600));
        assert_eq!(FormZone::read("America/Chicago").map(|z| DrawZone::from(&z)), Some(chicago));
        // Not known (no zone reported yet): UTC, and said so.
        assert_eq!(DrawZone::from(Visitor::default()).name(), "UTC");
        for text in ["Mars/Olympus", "../etc/passwd", "america/chicago", "utc", "Etc/Unknown"] {
            assert!(FormZone::read(text).is_none(), "{text}");
        }
    }

    /// The night Chicago's clocks go back, an edit form listed at 01:45 before the change, stored
    /// at 01:30 after it and drawn at 01:40 after it: drawn at their own readings, `min` (01:45)
    /// would be after the value and `max` (01:40) before it, and the browser would not send the
    /// form unchanged. `min` and `max` hold the value, and the post keeps the stored instant.
    #[cfg(feature = "zones")]
    #[test]
    fn bounds_drawn_where_the_clocks_go_back_hold_an_unchanged_value() {
        use crate::i18n::{parse_timestamp, Visitor};
        let ts = |text: &str| parse_timestamp(text).unwrap();
        let zone = DrawZone::from(Visitor::named("America/Chicago"));
        let (listed, stored, now) = (ts("2026-11-01T06:45:00Z"), ts("2026-11-01T07:30:00Z"), ts("2026-11-01T07:40:00Z"));
        let value = zone.local(stored).map(LocalDateTime::floor_minute).unwrap();
        let (min, max) = (zone.min(listed).unwrap(), zone.max(now).unwrap());
        assert_eq!(
            (min.to_string(), value.to_string(), max.to_string()),
            ("2026-11-01T00:45".into(), "2026-11-01T01:30".into(), "2026-11-01T02:40".into())
        );
        assert!(min <= value && value <= max, "the browser sends the input unchanged");
        assert!(zone.local(listed).map(LocalDateTime::floor_minute) > Some(value), "drawn at its own reading, min is after it");
        let posted = FormZone::read(zone.name()).unwrap();
        assert_eq!(crate::form::Entry::from(value).at_keeping(&posted, stored), Some(stored));
    }

    /// The second 01:30 of the night Chicago's clocks go back is drawn as 01:30, which reads as
    /// the first; an edit form that compares the field with what it drew keeps the stored instant.
    #[cfg(feature = "zones")]
    #[test]
    fn an_unchanged_field_keeps_a_stored_instant_in_a_repeated_hour() {
        use crate::i18n::{parse_timestamp, Visitor};
        let stored = parse_timestamp("2026-11-01T07:30:00Z").unwrap();
        let zone = DrawZone::from(Visitor::named("America/Chicago"));
        let drawn = zone.local(stored).map(LocalDateTime::floor_minute).unwrap();
        assert_eq!(drawn.to_string(), "2026-11-01T01:30");
        let posted = FormZone::read(zone.name()).unwrap();
        assert_eq!(drawn.at(&posted), parse_timestamp("2026-11-01T06:30:00Z"), "read alone: the first 01:30");
        let field = crate::form::Entry::from(drawn);
        assert_eq!(field.at_keeping(&posted, stored), Some(stored), "kept: the second");
        let other = parse_timestamp("2026-11-01T06:30:00Z").unwrap();
        assert_eq!(field.at_keeping(&posted, other), Some(other), "kept: the first, drawn the same");
    }
}
