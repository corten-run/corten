//! The zone a form's dates and times are drawn in, sent back with the form ([`FormZone`]).

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::form::FieldName;
use crate::i18n::{Offset, Utc, Zone};
use crate::view::{escape_into, Render};

/// The zone a form's dates and times are drawn in, sent back with the form so that its handler
/// reads them in the same zone: a hidden input the draw writes ([`FormZone::field`]) and a field
/// of this type the post reads. An [`Entry<LocalDateTime>`](crate::form::Entry) is read only in
/// one ([`Entry::at`](crate::form::Entry::at)), never in the zone of the request that posts it:
/// `req.zone()` is UTC on a browser's first page and in a `Public` page, and the visitor's own
/// zone on the post after it, so a form drawn in one and read in the other would store a time
/// moved by the visitor's offset, with nothing to say so.
///
/// It is sent as the name the visitor reads it by: `UTC`, an offset (`-06:00`), or a tz database
/// name (`America/Chicago`, with the `zones` feature). Show [`name`](FormZone::name) beside the
/// form's dates and times: without JavaScript a browser never reports its zone, so they are drawn
/// and read in UTC, and the visitor needs to see that to type a time in it.
///
/// ```
/// use corten::prelude::*;
/// use corten::form::{Entry, FormZone};
/// use corten::i18n::{parse_timestamp, LocalDateTime, Offset};
///
/// #[derive(Fields)]
/// struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
///
/// // Drawn in the request's zone (in a handler, `FormZone::from(req.zone())`).
/// let zone = FormZone::from(Offset::hours(-6));
/// let listed = parse_timestamp("2026-11-12T15:30:00Z").unwrap();
/// let f = Repair::FIELDS;
/// let form = html! {
///     <form method="post">
///         {zone.field(f.zone)}
///         <label>"Goes live (" {zone.name()} ")"
///             <input type="datetime-local" name={f.live_at} min={LocalDateTime::of(listed, &zone)}>
///         </label>
///     </form>
/// };
/// let html = form.to_html();
/// assert!(html.contains(r#"<input type="hidden" name="zone" value="-06:00">"#), "{html}");
/// assert!(html.contains("Goes live (-06:00)") && html.contains(r#"min="2026-11-12T09:30""#), "{html}");
///
/// // Read in the zone it was drawn in, whatever zone the post's request is in.
/// let posted: Repair = corten::form::from_bytes(b"live_at=2026-11-13T14%3A05&zone=-06%3A00").unwrap();
/// assert_eq!(posted.live_at.at(&posted.zone), parse_timestamp("2026-11-13T20:05:00Z"));
/// ```
///
/// A zone that is none of these is a 422 naming the field, as any typed field a page writes
/// itself: it came from no page of the app's.
///
/// ```
/// # use corten::prelude::*;
/// # use corten::form::{Entry, FormZone};
/// # use corten::i18n::LocalDateTime;
/// # #[derive(Fields)]
/// # struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
/// for zone in ["", "Mars%2FOlympus", "%2B25%3A00", "-6", "utc"] {
///     let body = format!("live_at=2026-11-13T14%3A05&zone={zone}");
///     assert!(corten::form::from_bytes::<Repair>(body.as_bytes()).is_err(), "{zone}");
/// }
/// assert!(corten::form::from_bytes::<Repair>(b"live_at=2026-11-13T14%3A05").is_err(), "not sent");
/// ```
///
/// [`field`](FormZone::field) takes only a `FormZone` field's name:
///
/// ```compile_fail,E0308
/// use corten::prelude::*;
/// use corten::form::{Entry, FormZone};
/// use corten::i18n::{LocalDateTime, Utc};
///
/// #[derive(Fields)]
/// struct Repair { live_at: Entry<LocalDateTime>, zone: FormZone }
///
/// let _ = FormZone::from(Utc).field(Repair::FIELDS.live_at);
/// ```
#[derive(Clone)]
pub struct FormZone {
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

impl FormZone {
    /// The hidden input that sends this zone back with the form:
    /// `<input type="hidden" name="zone" value="America/Chicago">`. Drawn again from a post that
    /// was refused, it is the posted zone, so the form drawn again is still in it.
    pub fn field(&self, name: FieldName<FormZone>) -> ZoneField<'_> {
        ZoneField { name: name.untyped(), zone: &self.name }
    }

    /// Its name, as sent and for the visitor to read beside the form's dates and times:
    /// `UTC`, an offset (`+05:30`), or a tz database name (`America/Chicago`).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The zone `text` names, as [`FormZone::name`] writes one.
    fn read(text: &str) -> Option<FormZone> {
        if text == "UTC" {
            return Some(Utc.into());
        }
        if let Some(east) = read_offset(text) {
            return Some(Offset::seconds(east).into());
        }
        // Only as the database writes it (jiff finds `america/chicago` too), so one zone is
        // sent one way, the way `field` draws it.
        #[cfg(feature = "zones")]
        if crate::client::zone_name(text) {
            let zone = crate::i18n::Visitor::named(text);
            if zone.name() == Some(text) {
                return Some(FormZone { name: text.into(), rules: Rules::Named(zone) });
            }
        }
        None
    }
}

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

/// `UTC`, as a form whose zone is not known (no JavaScript, a first page) is drawn in.
impl From<Utc> for FormZone {
    fn from(_: Utc) -> Self {
        FormZone { name: "UTC".into(), rules: Rules::Fixed(0) }
    }
}

/// Named by its offset (`-06:00`, `+05:30`), `UTC` for none. An offset zone is to the minute, as
/// Temporal's are, so one with seconds is taken to the minute toward zero, and the form is drawn
/// and read at the offset it names.
impl From<Offset> for FormZone {
    fn from(offset: Offset) -> Self {
        let east = offset.offset(UNIX_EPOCH) / 60 * 60;
        if east == 0 {
            return Utc.into();
        }
        let (sign, s) = (if east < 0 { '-' } else { '+' }, east.unsigned_abs());
        FormZone { name: format!("{sign}{:02}:{:02}", s / 3600, s / 60 % 60).into(), rules: Rules::Fixed(east) }
    }
}

/// The visitor's zone (`req.zone()`), by its tz database name; `UTC` when it is not known
/// (no JavaScript, a browser's first page, a `Public` page).
#[cfg(feature = "zones")]
impl From<crate::i18n::Visitor> for FormZone {
    fn from(zone: crate::i18n::Visitor) -> Self {
        match zone.name() {
            Some(name) if name != "UTC" => FormZone { name: name.into(), rules: Rules::Named(zone) },
            _ => Utc.into(),
        }
    }
}

impl Zone for FormZone {
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
}

impl PartialEq for FormZone {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

impl Eq for FormZone {}

impl fmt::Debug for FormZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FormZone({})", self.name)
    }
}

/// Its name, as it is sent.
impl fmt::Display for FormZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.name)
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

/// [`FormZone::field`]'s hidden input.
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
            (FormZone::from(Utc), "UTC"),
            (FormZone::from(Offset::hours(0)), "UTC"),
            (FormZone::from(Offset::hours(-6)), "-06:00"),
            (FormZone::from(Offset::seconds(5 * 3600 + 1800)), "+05:30"),
            (FormZone::from(Offset::seconds(-(3600 + 60 + 1))), "-01:01"),
            (FormZone::from(Offset::hours(14)), "+14:00"),
        ] {
            assert_eq!(zone.name(), name);
            let read = FormZone::read(name).unwrap();
            assert_eq!((read.name(), read.offset(UNIX_EPOCH)), (name, zone.offset(UNIX_EPOCH)), "{name}");
        }
        assert_eq!(FormZone::read("+00:00").unwrap().name(), "UTC");
        assert_eq!(FormZone::from(Offset::seconds(-(3600 + 60 + 1))).offset(UNIX_EPOCH), -3660, "to the minute");
        for text in
            ["", "utc", "Z", "+5:30", "+05:3", "+0530", "05:30", "+24:00", "+05:60", "+05:30:15", "+05:30:0", "Mars/Olympus"]
        {
            assert!(FormZone::read(text).is_none(), "{text:?}");
        }
        let mut out = String::new();
        FormZone::from(Offset::hours(-6)).field(FieldName::__new("zone")).render(&mut out);
        assert_eq!(out, r#"<input type="hidden" name="zone" value="-06:00">"#);
    }

    #[cfg(feature = "zones")]
    #[test]
    fn the_visitors_zone_is_sent_by_its_tz_database_name() {
        use crate::i18n::Visitor;
        use std::time::Duration;
        let chicago = FormZone::from(Visitor::named("America/Chicago"));
        let july = UNIX_EPOCH + Duration::from_secs(1_783_000_000);
        assert_eq!((chicago.name(), chicago.offset(july)), ("America/Chicago", -5 * 3600));
        assert_eq!(FormZone::read("America/Chicago"), Some(chicago));
        // Not known (no zone reported yet): UTC, and said so.
        assert_eq!(FormZone::from(Visitor::default()).name(), "UTC");
        for text in ["Mars/Olympus", "../etc/passwd", "america/chicago", "utc", "Etc/Unknown"] {
            assert!(FormZone::read(text).is_none(), "{text}");
        }
    }
}
