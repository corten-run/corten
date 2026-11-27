//! Reading a number the way a browser writes one, and a number field as typed.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, Visitor};

use crate::form::Numeric;
use crate::view::AttrValue;

/// `text` read as a number of type `T`, in HTML's syntax for a number (what an
/// `<input type="number">` sends): `-` or nothing, digits, a `.` and digits, an exponent
/// (`1e3`), with ASCII spaces around it allowed. An integer type takes a whole number written
/// any way the syntax allows (`3`, `3.0`, `3e0`, `-0` for an unsigned type) within its range;
/// a float takes a finite value. `None` for anything else: blank, `3.5` for an integer, `+3`,
/// `3.`, `0x10`, `inf`, `NaN`, or a value past the type's range.
///
/// ```
/// use corten::form::read_number;
///
/// assert_eq!(read_number::<u32>("1440.0"), Some(1440));
/// assert_eq!(read_number::<u32>("1e1"), Some(10));
/// assert_eq!(read_number::<u32>("3.5"), None);
/// assert_eq!(read_number::<u8>("256"), None);
/// assert_eq!(read_number::<f64>(".5"), Some(0.5));
/// assert_eq!(read_number::<f64>("inf"), None);
/// ```
///
/// A form and a route's query read a number field this way (a path parameter reads as written),
/// and [`Entry`] does for a field a user types.
pub fn read_number<T: Numeric>(text: &str) -> Option<T> {
    T::read(text)
}

/// A number written in HTML's syntax, taken apart: its sign, its digits without a point, and the
/// power of ten they are scaled by.
pub(crate) struct Written<'a> {
    pub negative: bool,
    /// The digits before and after the point, in order, without the point.
    pub whole: &'a [u8],
    pub fraction: &'a [u8],
    /// The exponent after `e`, saturated at `i64`'s range.
    pub exponent: i64,
}

/// `text` taken apart if it is a valid floating-point number in HTML's sense, else `None`.
pub(crate) fn written(text: &str) -> Option<Written<'_>> {
    let b = text.as_bytes();
    let mut i = 0;
    let negative = b.first() == Some(&b'-');
    if negative {
        i += 1;
    }
    let digits = |from: usize| from + b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let end = digits(i);
    let whole = &b[i..end];
    i = end;
    let mut fraction: &[u8] = &[];
    if b.get(i) == Some(&b'.') {
        let end = digits(i + 1);
        fraction = &b[i + 1..end];
        if fraction.is_empty() {
            return None; // `3.`
        }
        i = end;
    }
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    let mut exponent: i64 = 0;
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        let minus = match b.get(i) {
            Some(b'-') => {
                i += 1;
                true
            }
            Some(b'+') => {
                i += 1;
                false
            }
            _ => false,
        };
        let end = digits(i);
        if end == i {
            return None;
        }
        for &d in &b[i..end] {
            exponent = exponent.saturating_mul(10).saturating_add(i64::from(d - b'0'));
        }
        if minus {
            exponent = -exponent;
        }
        i = end;
    }
    (i == b.len()).then_some(Written { negative, whole, fraction, exponent })
}

/// A whole number's size, if `w` is one that fits a `u128`.
pub(crate) fn whole_magnitude(w: &Written<'_>) -> Option<u128> {
    // The digits before and after the point as one run; the point sits `fraction.len()` from its end.
    let digit = |k: usize| if k < w.whole.len() { w.whole[k] } else { w.fraction[k - w.whole.len()] } - b'0';
    let len = w.whole.len() + w.fraction.len();
    let Some(first) = (0..len).find(|&k| digit(k) != 0) else { return Some(0) };
    let last = (0..len).rev().find(|&k| digit(k) != 0)?;
    // The power of ten the last significant digit stands for: digit `k` is worth
    // 10^(exponent - fraction.len() + (len - 1 - k)).
    let after = i64::try_from(len - 1 - last).ok()?;
    let scale = w.exponent.saturating_sub(i64::try_from(w.fraction.len()).ok()?).saturating_add(after);
    if scale < 0 {
        return None; // a fraction
    }
    let mut n: u128 = 0;
    for k in first..=last {
        n = n.checked_mul(10)?.checked_add(u128::from(digit(k)))?;
    }
    n.checked_mul(10u128.checked_pow(u32::try_from(scale).ok()?)?)
}

/// A number field as the user typed it, and what it reads as: for a number a user types, whose
/// mistake is a message beside the field, not the error page a typed field (`qty: u32`) gives
/// one that does not read. Blank, not sent (a disabled input) or unreadable, its
/// [`value`](Entry::value) is `None`, and the form is drawn again with the text as it was sent.
/// A `type="number"` input shows a number as sent (`11` past a `max`) and text that is no number
/// (`4x` from another client) as empty, as browsers do; a text input
/// (`inputmode="numeric"`) shows either:
///
/// ```
/// use corten::prelude::*;
/// use corten::form::Entry;
///
/// #[derive(Fields)]
/// struct Line { copies: Entry<u32> }
///
/// const COPIES: Bounds<u32> = Bounds::new(0, 3);
///
/// let line: Line = corten::form::from_bytes(b"copies=4x").unwrap();
/// let mut errors = Errors::new();
/// if COPIES.read(&line.copies).is_none() {
///     errors.add(Line::FIELDS.copies, "Enter from 0 to 3 copies.");
/// }
/// assert!(errors.has(Line::FIELDS.copies));
/// let view = html! { <input inputmode="numeric" name={Line::FIELDS.copies} value={&line.copies}> };
/// assert!(view.to_html().contains(r#"value="4x""#));
///
/// // Not sent at all, as a disabled input is not: blank, not the error page.
/// let line: Line = corten::form::from_bytes(b"").unwrap();
/// assert!(line.copies.is_blank() && line.copies.value().is_none());
/// ```
///
/// A number a page writes itself (a link's parameter, a hidden input, a select's value) stays a
/// typed field: one that does not read came from no page of the app's. A number made in code
/// (`Entry::from(1)`) is drawn as the number.
#[derive(Clone, PartialEq)]
pub struct Entry<T> {
    /// As sent, or `None` for one made from a number.
    text: Option<Box<str>>,
    value: Option<T>,
}

impl<T: Numeric> Entry<T> {
    /// What `text` reads as ([`read_number`]), keeping the text.
    pub fn typed(text: &str) -> Self {
        Entry { value: read_number(text), text: Some(text.into()) }
    }

    /// The number, or `None` when the field was blank or does not read as one.
    pub fn value(&self) -> Option<T> {
        self.value
    }

    /// The text as it was sent, or `None` for an entry made from a number.
    pub fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }

    /// Whether the field was sent blank (or holds only spaces) or not sent: what an optional
    /// number is allowed to be (`input.weight.is_blank() || WEIGHT.read(&input.weight).is_some()`).
    pub fn is_blank(&self) -> bool {
        self.value.is_none() && self.text.as_deref().is_none_or(|t| t.trim_ascii().is_empty())
    }
}

/// No text and no number: an empty input.
impl<T> Default for Entry<T> {
    fn default() -> Self {
        Entry { text: None, value: None }
    }
}

impl<T: Numeric> From<T> for Entry<T> {
    fn from(value: T) -> Self {
        Entry { text: None, value: Some(value) }
    }
}

impl<T: fmt::Debug> fmt::Debug for Entry<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Entry").field("text", &self.text).field("value", &self.value).finish()
    }
}

/// The input's `value`: the text as sent, or the number; nothing for an empty entry.
impl<T: Numeric> AttrValue for Entry<T> {
    fn write_attr(&self, name: &str, out: &mut String) {
        match (&self.text, self.value) {
            (Some(text), _) => text.write_attr(name, out),
            (None, Some(value)) => crate::view::quoted(name, &value, out),
            (None, None) => {}
        }
    }
}

impl<'de, T: Numeric> Deserialize<'de> for Entry<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text<T>(std::marker::PhantomData<T>);
        impl<'de, T: Numeric> Visitor<'de> for Text<T> {
            type Value = Entry<T>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a number field's text")
            }
            fn visit_str<E: de::Error>(self, text: &str) -> Result<Entry<T>, E> {
                Ok(Entry::typed(text))
            }
            /// Not sent (a disabled input, another client) or sent blank: blank.
            fn visit_none<E: de::Error>(self) -> Result<Entry<T>, E> {
                Ok(Entry::typed(""))
            }
            fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Entry<T>, D::Error> {
                d.deserialize_str(self)
            }
        }
        deserializer.deserialize_option(Text(std::marker::PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_take_any_way_html_writes_a_whole_number() {
        for (text, n) in [
            ("3", 3u32),
            ("3.0", 3),
            ("3e0", 3),
            ("30e-1", 3),
            ("1e1", 10),
            ("1440.0", 1440),
            ("-0", 0),
            (" 7 ", 7),
            ("007", 7),
            (".0", 0),
            ("4294967295", u32::MAX),
            ("4.294967295e9", u32::MAX),
            ("0e999999999999999999999", 0),
        ] {
            assert_eq!(read_number::<u32>(text), Some(n), "{text}");
        }
        for text in [
            "",
            " ",
            "3.5",
            "3.",
            "+3",
            "0x10",
            "1e",
            "1e+",
            "--1",
            "-1",
            "4294967296",
            "1e10",
            "1e400",
            "3,000",
            "٣",
            "inf",
            "1_000",
            "3 4",
        ] {
            assert_eq!(read_number::<u32>(text), None, "{text}");
        }
        assert_eq!(read_number::<i8>("-128"), Some(-128));
        assert_eq!(read_number::<i8>("-1.28e2"), Some(-128));
        assert_eq!(read_number::<i8>("-129"), None);
        assert_eq!(read_number::<i128>("-170141183460469231731687303715884105728"), Some(i128::MIN));
        assert_eq!(read_number::<u128>("340282366920938463463374607431768211455"), Some(u128::MAX));
        assert_eq!(read_number::<u128>("340282366920938463463374607431768211456"), None);
        assert_eq!(read_number::<u64>("0.0000000000000000000000000000000000000000001e43"), Some(1));
    }

    #[test]
    fn floats_take_html_syntax_and_a_finite_value() {
        for (text, n) in [("0.5", 0.5f64), (".5", 0.5), ("-0.25", -0.25), ("1e3", 1000.0), ("1E-2", 0.01), ("12", 12.0)] {
            assert_eq!(read_number::<f64>(text), Some(n), "{text}");
        }
        for text in
            ["", "5.", "5.e3", "+5", "+.5", "-", ".", "inf", "-inf", "NaN", "infinity", "1e400", "0x1p3", "1,5", "1e", "e3"]
        {
            assert_eq!(read_number::<f64>(text), None, "{text}");
        }
        assert_eq!(read_number::<f32>("0.1"), Some(0.1f32));
        assert_eq!(read_number::<f32>("1e39"), None);
        // Every text of up to five of these characters reads as a float exactly when it is HTML's
        // syntax for a number, as `written` takes it apart.
        // (`inf` and `NaN` are in the list above.)
        let chars = ['1', '0', '.', 'e', 'E', '+', '-', ' '];
        let mut texts = vec![String::new()];
        for _ in 0..5 {
            let longer: Vec<String> = texts.iter().flat_map(|t| chars.iter().map(move |c| format!("{t}{c}"))).collect();
            texts.extend(longer.into_iter().filter(|t| t.len() <= 5));
            texts.sort();
            texts.dedup();
        }
        for text in &texts {
            let html = written(text.trim_ascii()).is_some();
            assert_eq!(read_number::<f64>(text).is_some(), html, "{text:?}");
        }
    }

    #[test]
    fn an_entry_keeps_its_text_and_reads_it() {
        let e = Entry::<u32>::typed(" 12 ");
        assert_eq!((e.value(), e.text(), e.is_blank()), (Some(12), Some(" 12 "), false));
        let blank = Entry::<u32>::typed("");
        assert_eq!((blank.value(), blank.is_blank()), (None, true));
        assert!(Entry::<u32>::default().is_blank() && !Entry::from(0u32).is_blank(), "nothing is blank; a number is not");
        let bad = Entry::<f64>::typed("1,5");
        assert_eq!((bad.value(), bad.text()), (None, Some("1,5")));
        let mut out = String::new();
        bad.write_attr(" value", &mut out);
        Entry::from(7u32).write_attr(" value", &mut out);
        Entry::<u32>::default().write_attr(" value", &mut out);
        assert_eq!(out, r#" value="1,5" value="7""#);
    }
}
