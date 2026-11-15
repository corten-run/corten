//! A number field's allowed values, written once for the input and the handler.

use crate::view::{quoted, Attrs, Render};

/// The values a number field allows: from `min` to `max`, in steps of `step` counted from
/// `min` (1 unless set, as in HTML). One constant gives the input its `min`, `max` and `step`
/// (`{..COPIES}`) and the handler its check ([`Bounds::holds`]), so the browser and the server
/// cannot disagree about them:
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Line { copies: u32 }
///
/// const COPIES: Bounds<u32> = Bounds::new(0, 3);
///
/// let f = Line::FIELDS;
/// let view = html! { <input type="number" name={f.copies} {..COPIES}> };
/// assert_eq!(view.to_html(), r#"<input type="number" name="copies" min="0" max="3" step="1">"#);
///
/// let line = Line { copies: 4 };
/// let mut errors = Errors::new();
/// if !COPIES.holds(line.copies) {
///     errors.add(f.copies, format!("A deck holds at most {} copies.", COPIES.max()));
/// }
/// assert_eq!(errors.get(f.copies), Some("A deck holds at most 3 copies."));
/// ```
///
/// The field's own type reads the number (a blank field is `None` for an `Option`, checked as
/// `input.weight.is_none_or(|w| WEIGHT.holds(w))`), and the message is the app's, as every
/// rule's is. A decimal field sets its step (`Bounds::new(0.0, 10_000.0).step(0.01)`); `holds`
/// asks whether a value a browser accepts, `min` plus a whole number of steps typed in decimal,
/// reads as the same float, so `0.3` is on a step of `0.01` and `4915.205` is not. That is exact
/// while the float tells a step apart, to 6 significant digits for an `f32` (most of 7) and 15 for
/// an `f64`; past that, entries a step apart read as one float, which holds if one of them is on
/// the step. A value is refused when it, `min` and `step` need more than 38 digits side by side
/// (`1e30` in steps of `1e-9`), unless an estimate in floating point finds the step.
/// A field has both ends: the server checks a value it was sent against both, so the input says
/// them too.
///
/// A decimal with no step, a ratio or a percentile that takes whatever precision is typed, is
/// [`any_step`](Bounds::any_step), which writes HTML's `step="any"` and holds every finite number
/// from `min` to `max`. An end the value must stay off ("above 0", "below 1") is
/// [`exclusive_min`](Bounds::exclusive_min) or [`exclusive_max`](Bounds::exclusive_max). HTML
/// has no exclusive `min` or `max`. With a step the input says the first and last steps inside
/// the ends (`min="0.1"` above 0 in tenths), so the browser checks them too; with any step there is
/// no next number, so the input says the end itself, the browser lets it through, and the handler
/// refuses it, with the field's message, which says "above":
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Listing { discount: Entry<f64> }
///
/// /// A percentage off, as precise as the seller likes: above 0 and below 100.
/// const DISCOUNT: Bounds<f64> = Bounds::new(0.0, 100.0).exclusive_min().exclusive_max().any_step();
///
/// let f = Listing::FIELDS;
/// let view = html! { <input type="number" name={f.discount} {..DISCOUNT}> };
/// assert_eq!(view.to_html(), r#"<input type="number" name="discount" min="0" max="100" step="any">"#);
///
/// assert!(DISCOUNT.holds(37.5) && DISCOUNT.holds(0.001));
/// assert!(!DISCOUNT.holds(0.0) && !DISCOUNT.holds(100.0));
/// assert_eq!(DISCOUNT.step_size(), None);
/// ```
///
/// A count has neither: its next whole number is the end it stays off (`Bounds::new(1, 9)` is
/// above 0), and a number input with `step="any"` would send `2.5`, which no integer reads. So
/// they are a float's alone, and an integer's bounds with either do not compile:
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const COPIES: Bounds<u32> = Bounds::new(0, 3).any_step();
/// ```
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const COPIES: Bounds<u32> = Bounds::new(0, 3).exclusive_min();
/// ```
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const COPIES: Bounds<i64> = Bounds::new(-3, 3).exclusive_max();
/// ```
///
/// A step not above zero holds nothing, so every value is refused: a browser ignores such a step
/// and steps by 1, and the handler must not agree to values the input never offered.
///
/// The spread writes `min`, `max` and `step`, so a tag that writes one of them as well does
/// not compile:
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
///
/// const COPIES: Bounds<u32> = Bounds::new(0, 3);
/// let view = html! { <input type="number" max="4" {..COPIES}> };
/// # let _ = view.to_html();
/// ```
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds<T> {
    min: T,
    max: T,
    /// `None` for `step="any"`.
    step: Option<T>,
    /// Whether `min` and `max` themselves are refused.
    above: bool,
    below: bool,
}

impl<T: Numeric> Bounds<T> {
    /// Whole steps of 1 from `min` to `max`, both included. A `min` above `max` holds nothing.
    pub const fn new(min: T, max: T) -> Self {
        Bounds { min, max, step: Some(T::ONE), above: false, below: false }
    }

    /// Steps of `step` from `min`: `0.01` for cents, `5` for a count in fives.
    pub const fn step(self, step: T) -> Self {
        Bounds { min: self.min, max: self.max, step: Some(step), above: self.above, below: self.below }
    }

    pub const fn min(&self) -> T {
        self.min
    }

    pub const fn max(&self) -> T {
        self.max
    }

    /// The step, or `None` for [`any_step`](Bounds::any_step).
    pub const fn step_size(&self) -> Option<T> {
        self.step
    }

    /// What a typed field reads as when it is a number these bounds hold: `None` when it is blank,
    /// does not read, or is out of bounds, each of which the handler answers with the field's
    /// message.
    pub fn read(&self, entry: &super::Entry<T>) -> Option<T> {
        entry.value().filter(|&v| self.holds(v))
    }

    /// Whether `value` is from `min` to `max` (off an exclusive end) and a whole number of steps
    /// from `min`: what a browser checks before it sends the form, checked again by the handler,
    /// which also refuses an exclusive end the browser lets through.
    pub fn holds(&self, value: T) -> bool {
        let above = if self.above { self.min < value } else { self.min <= value };
        let below = if self.below { value < self.max } else { value <= self.max };
        above
            && below
            && match self.step {
                // A finite number in range: an infinite `max` does not hold infinity.
                None => value.is_finite(),
                Some(step) => T::ZERO < step && value.on_step(self.min, step),
            }
    }
}

impl<T: Float> Bounds<T> {
    /// Every number from `min` to `max`, with as many decimals as are typed: the input's
    /// `step="any"`. Set after [`step`](Bounds::step), it replaces it, and `step` after it
    /// replaces it in turn.
    pub const fn any_step(self) -> Self {
        Bounds { min: self.min, max: self.max, step: None, above: self.above, below: self.below }
    }

    /// Refuses `min` itself: "above 0". HTML has no exclusive end: with a step the input says the
    /// first step above `min` that reads as more than it (a step finer than the float tells apart
    /// near `min` reads as `min` for a few steps, which are passed over); with
    /// [`any_step`](Bounds::any_step) it says `min`, which the browser sends and the handler
    /// refuses.
    pub const fn exclusive_min(self) -> Self {
        Bounds { min: self.min, max: self.max, step: self.step, above: true, below: self.below }
    }

    /// Refuses `max` itself: "below 1": with a step the input says the last step below `max`,
    /// and with [`any_step`](Bounds::any_step) `max`, as for [`exclusive_min`](Bounds::exclusive_min).
    pub const fn exclusive_max(self) -> Self {
        Bounds { min: self.min, max: self.max, step: self.step, above: self.above, below: true }
    }
}

impl<T: Numeric> Bounds<T> {
    /// The step inside an exclusive end that the input says in its place, as text and as the
    /// number it reads as. `None` for an end the input says as it is: inclusive, with no step, or
    /// where the digits do not line up (the bounds then hold no value near the end either).
    fn inside(&self, last: bool) -> Option<(String, T)> {
        let step = self.step?;
        if (last && !self.below) || (!last && !self.above) {
            return None;
        }
        let decimal = T::step_inside(self.min, self.max, step, last)?;
        let mut text = String::new();
        write_decimal(decimal, &mut text);
        let value = T::read(&text)?;
        Some((text, value))
    }

    /// The `min` and `max` the input says, as numbers: what corten-ui's `NumberField` disables
    /// its buttons at.
    #[doc(hidden)]
    pub fn drawn(&self) -> (T, T) {
        let at = |last: bool, end: T| self.inside(last).map_or(end, |(_, value)| value);
        (at(false, self.min), at(true, self.max))
    }
}

impl<T: Numeric> Attrs for Bounds<T> {
    fn render_attrs(&self, out: &mut String) {
        for (name, end, last) in [(" min", &self.min, false), (" max", &self.max, true)] {
            match self.inside(last) {
                // Digits and a point: nothing to escape.
                Some((text, _)) => {
                    out.push_str(name);
                    out.push_str("=\"");
                    out.push_str(&text);
                    out.push('"');
                }
                None => quoted(name, end, out),
            }
        }
        match &self.step {
            Some(step) => quoted(" step", step, out),
            None => out.push_str(" step=\"any\""),
        }
    }
}

/// `digits` times ten to `exponent` in HTML's syntax for a number, with no exponent and no
/// trailing zeros: `(25, -2)` is `0.25`.
fn write_decimal((digits, exponent): (i128, i32), out: &mut String) {
    if digits < 0 {
        out.push('-');
    }
    let text = digits.unsigned_abs().to_string();
    let Ok(point) = usize::try_from(-i64::from(exponent)) else {
        out.push_str(&text);
        out.extend(std::iter::repeat_n('0', exponent.unsigned_abs() as usize));
        return;
    };
    let padded = format!("{text:0>width$}", width = point + 1);
    let (whole, fraction) = padded.split_at(padded.len() - point);
    let fraction = fraction.trim_end_matches('0');
    out.push_str(whole);
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(fraction);
    }
}

impl<T: Numeric> crate::view::__private::Writes for Bounds<T> {
    type Static = Self;
    const WRITES: &'static [&'static str] = &["min", "max", "step"];
}

/// A float, whose [`Bounds`] can have [`any_step`](Bounds::any_step) and an exclusive end. Sealed.
#[diagnostic::on_unimplemented(
    message = "`{Self}` is a whole number: its bounds have a step and include both ends",
    label = "a float's bounds alone take this",
    note = "a count stays off an end with its next whole number: `Bounds::new(1, 9)` is above 0"
)]
pub trait Float: Numeric {}

/// A number a [`Bounds`] holds: an integer or a float. Sealed.
#[diagnostic::on_unimplemented(message = "a number field reads an integer or a float, not `{Self}`")]
pub trait Numeric: Copy + PartialOrd + Render + std::fmt::Debug + sealed::Sealed + 'static {
    #[doc(hidden)]
    const ZERO: Self;
    #[doc(hidden)]
    const ONE: Self;
    /// `text` read in HTML's syntax for a number, ASCII spaces around it allowed: see
    /// [`read_number`](crate::form::read_number).
    #[doc(hidden)]
    fn read(text: &str) -> Option<Self>;
    /// Whether `self`, at least `from`, is a whole number of `step`s (above zero) from it.
    #[doc(hidden)]
    fn on_step(self, from: Self, step: Self) -> bool;
    /// Not an infinity or NaN; every integer.
    #[doc(hidden)]
    fn is_finite(self) -> bool;
    /// The first step above `min` that reads as more than `min`, or (`last`) the last one below
    /// `max` that reads as less, exactly, as digits and an exponent. Past an empty range: the first
    /// is above the last. `None` where the digits do not line up, and for an integer, which has no
    /// exclusive end.
    #[doc(hidden)]
    fn step_inside(min: Self, max: Self, step: Self, last: bool) -> Option<(i128, i32)>;
    /// `self` as an input's value, with the decimals of `step`: `12.5` in steps of `0.01` is
    /// `12.50`. A whole number as it is.
    #[doc(hidden)]
    fn shown(self, step: Self) -> String;
}

mod sealed {
    pub trait Sealed {}
}

macro_rules! whole {
    ($($t:ty => $u:ty),*) => {$(
        impl sealed::Sealed for $t {}
        impl Numeric for $t {
            const ZERO: Self = 0;
            const ONE: Self = 1;
            fn read(text: &str) -> Option<Self> {
                // Digits alone, as a page's own links and most inputs write them, before anything
                // else is looked at.
                // `str::parse` takes digits after a leading `+` (which HTML does not) or `-`,
                // and nothing else, so a text it reads that starts with a digit is digits alone.
                if text.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                    if let Ok(value) = text.parse() {
                        return Some(value);
                    }
                }
                let written = super::number::written(text.trim_ascii())?;
                let size = super::number::whole_magnitude(&written)?;
                if written.negative && size != 0 {
                    // `i128::MIN`'s size is one past `i128::MAX`.
                    let value = if size == i128::MAX as u128 + 1 { i128::MIN } else { -i128::try_from(size).ok()? };
                    Self::try_from(value).ok()
                } else {
                    Self::try_from(size).ok()
                }
            }
            #[inline]
            fn on_step(self, from: Self, step: Self) -> bool {
                // `self >= from`, so the difference fits the unsigned type even when the signed
                // one would overflow.
                (self as $u).wrapping_sub(from as $u) % (step as $u) == 0
            }
            fn is_finite(self) -> bool {
                true
            }
            fn step_inside(_: Self, _: Self, _: Self, _: bool) -> Option<(i128, i32)> {
                None
            }
            fn shown(self, _: Self) -> String {
                self.to_string()
            }
        }
    )*};
}
whole!(u8 => u8, u16 => u16, u32 => u32, u64 => u64, u128 => u128, usize => usize,
    i8 => u8, i16 => u16, i32 => u32, i64 => u64, i128 => u128, isize => usize);

macro_rules! float {
    ($($t:ty),*) => {$(
        impl sealed::Sealed for $t {}
        impl Float for $t {}
        impl Numeric for $t {
            const ZERO: Self = 0.0;
            const ONE: Self = 1.0;
            fn read(text: &str) -> Option<Self> {
                // Rust's grammar is HTML's plus a leading `+`, a point with no digit after it
                // (`5.`, `5.e3`), and `inf` and `NaN`, which no finite value is.
                let text = text.trim_ascii();
                let value = text.parse::<$t>().ok().filter(|v| v.is_finite())?;
                let point = text.bytes().position(|b| b == b'.');
                let digit_after = point.is_none_or(|at| text.as_bytes().get(at + 1).is_some_and(u8::is_ascii_digit));
                (!text.starts_with('+') && digit_after).then_some(value)
            }
            fn on_step(self, from: Self, step: Self) -> bool {
                // The steps nearest the value, each written in decimal as a browser would have
                // it typed and read back as this type: the value is on a step when one reads as it.
                let (Some(value), Some(from_at), Some(step_at)) = (Decimal::of(self), Decimal::of(from), Decimal::of(step)) else {
                    return false;
                };
                // The nearest step exactly, in decimal, where the digits line up in an `i128`;
                // else estimated in f64, whose error grows with the number of steps, so this path
                // mostly refuses: no step near the estimate reads as the value.
                let near = match value.steps_from(from_at, step_at) {
                    Some(near) => near,
                    None => {
                        let near = ((self as f64 - from as f64) / step as f64).round();
                        if near.is_nan() || near.abs() >= 1e30 {
                            return false;
                        }
                        near as i128
                    }
                };
                let (from, step) = (from_at, step_at);
                [near - 1, near, near + 1].into_iter().any(|k| {
                    let mut text = Buf { bytes: [0; 64], len: 0 };
                    k >= 0
                        && from.plus_steps(step, k).is_some_and(|(digits, exponent)| {
                            use std::fmt::Write;
                            write!(text, "{digits}e{exponent}").is_ok()
                                && std::str::from_utf8(&text.bytes[..text.len]).ok().and_then(|t| t.parse::<$t>().ok()) == Some(self)
                        })
                })
            }
            fn is_finite(self) -> bool {
                <$t>::is_finite(self)
            }
            fn step_inside(min: Self, max: Self, step: Self, last: bool) -> Option<(i128, i32)> {
                // The steps count from `min`; `max` matters only to the last one.
                if !(step.is_finite() && min.is_finite() && (!last || max.is_finite())) || step <= 0.0 {
                    return None;
                }
                let (from, by) = (Decimal::of(min)?, Decimal::of(step)?);
                // A step finer than the float tells apart at the end reads as the end for a while:
                // within the float's spacing there, and the decimal `min` is written as (the
                // steps' origin) is within half of it. What a step reads as only grows with it, so
                // the step wanted is found by halving that span.
                let spacing = if last { max - max.next_down() } else { min.next_up() - min };
                let span = (spacing as f64 / step as f64).ceil() + 1.0;
                if !span.is_finite() || span >= 1e30 {
                    return None;
                }
                let span = span as i128;
                // Whether the `k`th step from `min` reads inside the end: `None` past an i128.
                let inside = |k: i128| {
                    let (digits, exponent) = from.plus_steps(by, k)?;
                    let value = format!("{digits}e{exponent}").parse::<$t>().ok()?;
                    Some(if last { value < max } else { value > min })
                };
                let (mut lo, mut hi) = if last {
                    let nearest = Decimal::of(max)?.steps_below(from, by)?;
                    ((nearest - span).max(0), nearest)
                } else {
                    (1, span)
                };
                // The first step inside above `min`, or the last one below `max`.
                if !inside(if last { lo } else { hi })? {
                    return None;
                }
                while lo < hi {
                    if last {
                        let mid = lo + (hi - lo + 1) / 2;
                        if inside(mid)? {
                            lo = mid;
                        } else {
                            hi = mid - 1;
                        }
                    } else {
                        let mid = lo + (hi - lo) / 2;
                        if inside(mid)? {
                            hi = mid;
                        } else {
                            lo = mid + 1;
                        }
                    }
                }
                from.plus_steps(by, lo)
            }
            fn shown(self, step: Self) -> String {
                let text = step.to_string();
                let decimals = text.split_once('.').map_or(0, |(_, fraction)| fraction.len());
                format!("{self:.decimals$}")
            }
        }
    )*};
}
float!(f32, f64);

/// A float as the shortest decimal that reads back as it (what `Display` writes): `digits` times
/// ten to `exponent`. `None` for an infinity or NaN.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Decimal {
    digits: i128,
    exponent: i32,
}

impl Decimal {
    fn of(value: impl std::fmt::LowerExp) -> Option<Self> {
        use std::fmt::Write;
        // `{:e}` is the shortest decimal in one form, `-4.915205e3`, which fits 32 bytes for an f64.
        let mut text = Buf { bytes: [0; 32], len: 0 };
        write!(text, "{value:e}").ok()?;
        let text = std::str::from_utf8(&text.bytes[..text.len]).ok()?;
        let (mantissa, exponent) = text.split_once('e')?;
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let negative = whole.starts_with('-');
        let whole = whole.trim_start_matches('-');
        let mut digits: i128 = 0;
        for b in whole.bytes().chain(fraction.bytes()) {
            if !b.is_ascii_digit() {
                return None; // `inf`, `NaN`
            }
            digits = digits.checked_mul(10)?.checked_add(i128::from(b - b'0'))?;
        }
        let exponent = exponent.parse::<i32>().ok()?.checked_sub(i32::try_from(fraction.len()).ok()?)?;
        Some(Decimal { digits: if negative { -digits } else { digits }, exponent })
    }

    /// The whole number of `step`s nearest `self` from `from`: `None` when their digits do not
    /// line up in an `i128`.
    fn steps_from(self, from: Decimal, step: Decimal) -> Option<i128> {
        let exponent = self.exponent.min(from.exponent).min(step.exponent);
        let (apart, step) = (self.at(exponent)?.checked_sub(from.at(exponent)?)?, step.at(exponent)?);
        let (whole, left) = (apart.div_euclid(step), apart.rem_euclid(step));
        Some(if left >= step - left { whole + 1 } else { whole })
    }

    /// The most whole `step`s from `from` that stay below `self`: `None` when none do, or the
    /// digits do not line up in an `i128`.
    fn steps_below(self, from: Decimal, step: Decimal) -> Option<i128> {
        let exponent = self.exponent.min(from.exponent).min(step.exponent);
        let (apart, step) = (self.at(exponent)?.checked_sub(from.at(exponent)?)?, step.at(exponent)?);
        (apart > 0).then(|| (apart - 1).div_euclid(step))
    }

    /// `self` plus `k` times `step`, exactly: digits and an exponent, `None` past an `i128`.
    fn plus_steps(self, step: Decimal, k: i128) -> Option<(i128, i32)> {
        let exponent = self.exponent.min(step.exponent);
        Some((self.at(exponent)?.checked_add(step.at(exponent)?.checked_mul(k)?)?, exponent))
    }

    /// The digits at a smaller `exponent`: `None` past an `i128`.
    fn at(self, exponent: i32) -> Option<i128> {
        if self.digits == 0 {
            return Some(0);
        }
        let shift = u32::try_from(self.exponent - exponent).ok()?;
        self.digits.checked_mul(10i128.checked_pow(shift)?)
    }
}

/// A stack buffer a check writes its decimals into, so it allocates nothing.
struct Buf<const N: usize = 32> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> std::fmt::Write for Buf<N> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let end = self.len + s.len();
        self.bytes.get_mut(self.len..end).ok_or(std::fmt::Error)?.copy_from_slice(s.as_bytes());
        self.len = end;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_numbers_hold_from_min_to_max_on_a_step() {
        let copies = Bounds::new(0u32, 3);
        assert!((0..=3).all(|n| copies.holds(n)));
        assert!(!copies.holds(4));
        let fives = Bounds::new(10u32, 50).step(5);
        assert!(fives.holds(10) && fives.holds(45) && fives.holds(50));
        assert!(!fives.holds(12) && !fives.holds(5) && !fives.holds(55));
    }

    #[test]
    fn signed_bounds_across_the_whole_type_do_not_overflow() {
        let all = Bounds::new(i64::MIN, i64::MAX);
        assert!(all.holds(i64::MIN) && all.holds(0) && all.holds(i64::MAX));
        assert!(Bounds::new(i8::MIN, i8::MAX).step(2).holds(126) && !Bounds::new(i8::MIN, i8::MAX).step(2).holds(127));
        assert!(Bounds::new(-10i32, 10).step(5).holds(-5) && !Bounds::new(-10i32, 10).step(5).holds(-4));
    }

    #[test]
    fn a_min_above_max_holds_nothing() {
        assert!(!Bounds::new(5u32, 1).holds(3));
        assert!(!Bounds::new(1.0, 0.0).holds(0.5));
    }

    #[test]
    fn a_step_not_above_zero_holds_nothing() {
        assert!(!Bounds::new(0u32, 10).step(0).holds(5));
        assert!(!Bounds::new(-10i32, 10).step(-1).holds(5));
        assert!(!Bounds::new(0.0, 10.0).step(-1.0).holds(5.0));
        assert!(!Bounds::new(0.0, 10.0).step(0.0).holds(5.0));
        assert!(!Bounds::new(0.0, 10.0).step(f64::NAN).holds(5.0));
    }

    #[test]
    fn decimals_hold_on_their_step_despite_binary_rounding() {
        let cents = Bounds::new(0.0, 10_000.0).step(0.01);
        assert!(cents.holds(0.3) && cents.holds(19.99) && cents.holds(10_000.0));
        assert!(!cents.holds(0.005) && !cents.holds(10_000.01) && !cents.holds(-0.01));
        assert!(!cents.holds(f64::NAN) && !cents.holds(f64::INFINITY));
        let big = Bounds::new(0.0, 1e15).step(0.01);
        assert!(big.holds(9_999_999.99) && !big.holds(9_999_999.995));
        assert!(big.holds(3_000_000_000_000.01) && !big.holds(3_000_000_000_000.005));
        let tenths = Bounds::new(0.1f32, 5.0).step(0.1);
        assert!(tenths.holds(0.3) && tenths.holds(5.0) && !tenths.holds(0.25));
        let offset = Bounds::new(-1000.5, 1000.0).step(0.25);
        assert!(offset.holds(-1000.25) && offset.holds(999.5) && !offset.holds(999.6));
    }

    #[test]
    fn half_a_step_is_refused_at_any_size() {
        // An f32's half cents and half units, which a tolerance in binary let through.
        let cents = Bounds::new(0.0f32, 10_000.0).step(0.01);
        assert!(!cents.holds(4915.205) && !cents.holds(6000.005) && !cents.holds(7777.777));
        assert!(cents.holds(4915.2) && cents.holds(9999.99));
        let units = Bounds::new(0.0f32, 1e7).step(1.0);
        assert!(!units.holds(524_288.5) && units.holds(524_288.0));
        let wide = Bounds::new(0.0f64, 1e300).step(1.0);
        assert!(!wide.holds(283_000_000_000_000.5) && wide.holds(283_000_000_000_000.0));
    }

    #[test]
    fn every_cent_reads_as_on_its_step() {
        let cents = Bounds::new(0.0, 100_000.0).step(0.01);
        assert!((0..=10_000_000u32).step_by(7).all(|n| cents.holds(f64::from(n) / 100.0)));
        let from = Bounds::new(12.34, 1e6).step(0.05);
        assert!((0..200_000u32).all(|n| from.holds(format!("{:.2}", 12.34 + f64::from(n) * 0.05).parse().unwrap())));
    }

    #[test]
    fn a_step_the_float_holds_only_rounded_is_on_its_step() {
        // On-step entries whose float has more digits than its shortest decimal shows, read from
        // text as a form sends them.
        let typed32 = |t: &str| t.parse::<f32>().unwrap();
        let typed64 = |t: &str| t.parse::<f64>().unwrap();
        let quarters = Bounds::new(0.0f32, 2e7).step(0.25);
        assert!(["1234567.25", "1234567.75", "2000000.25", "1048589.25"].into_iter().all(|t| quarters.holds(typed32(t))));
        assert!(!quarters.holds(typed32("1048589.125")));
        assert!((4_194_000..4_195_000u32).all(|n| quarters.holds(typed32(&format!("{n}.25")))));
        assert!(Bounds::new(0.0, 1e16).step(0.25).holds(typed64("600000000000000.25")));
        assert!(Bounds::new(0.0, 1e16).step(0.125).holds(typed64("300000000000000.125")));
        // Past the digits a float keeps, where the nearest step must be found exactly.
        assert!(Bounds::new(0.0f32, 1e7).step(0.01).holds(typed32("335545.10")));
        assert!(Bounds::new(0.0f32, 1e8).step(0.1).holds(typed32("3355538.3")));
        assert!(Bounds::new(0.0, 1e18).step(0.01).holds(typed64("360429999991940.11")));
        assert!(Bounds::new(0.0, 1e18).step(0.1).holds(typed64("1801999999999489.4")));
    }

    #[test]
    fn digits_too_many_to_line_up_are_refused() {
        // Exact while the digits fit 38 side by side, so 1e31 in steps of 1 is on a step.
        assert!(Bounds::new(0.0, f64::MAX).holds(1e31));
        assert!(!Bounds::new(0.0, f64::MAX).step(1e-9).holds(1e30));
        assert!(!Bounds::new(0.0, f64::MAX).holds(1e300));
        assert!(!Bounds::new(f64::MIN, f64::MAX).holds(f64::INFINITY));
        assert!(!Bounds::new(0.0, 1.0).step(0.1).holds(f64::NAN));
        assert!(Bounds::new(0.0, 1.0).step(5e-324).holds(5e-324));
    }

    #[test]
    fn any_step_holds_every_finite_number_in_range() {
        let ratio = Bounds::new(0.0, 1.0).any_step();
        assert!(ratio.holds(0.0) && ratio.holds(0.375) && ratio.holds(1.0 / 3.0) && ratio.holds(1.0));
        assert!(!ratio.holds(-0.000_001) && !ratio.holds(1.000_000_1));
        assert!(!ratio.holds(f64::NAN) && !ratio.holds(f64::INFINITY) && !ratio.holds(f64::NEG_INFINITY));
        // An infinite end does not let infinity through.
        let open = Bounds::new(f64::NEG_INFINITY, f64::INFINITY).any_step();
        assert!(open.holds(f64::MAX) && open.holds(f64::MIN) && !open.holds(f64::INFINITY) && !open.holds(f64::NEG_INFINITY));
        assert!(!Bounds::new(1.0f32, 0.0).any_step().holds(0.5));
        assert_eq!(ratio.step_size(), None);
        // The last of `step` and `any_step` holds.
        assert_eq!(ratio.step(0.25).step_size(), Some(0.25));
        assert!(!ratio.step(0.25).holds(0.3));
        assert_eq!(Bounds::new(0.0, 1.0).step(0.25).any_step().step_size(), None);
    }

    #[test]
    fn an_exclusive_end_refuses_the_end_and_holds_the_next_number() {
        let above = Bounds::new(0.0, 10.0).exclusive_min().any_step();
        assert!(!above.holds(0.0) && !above.holds(-0.0));
        // The smallest f64 above zero reads from a form and holds.
        let least = super::super::Entry::<f64>::typed("5e-324");
        assert_eq!(least.value(), Some(5e-324));
        assert_eq!(above.read(&least), Some(5e-324));
        assert!(above.holds(10.0));
        let one = Bounds::new(1.0, 2.0).exclusive_min().exclusive_max().any_step();
        assert!(!one.holds(1.0) && one.holds(1.0f64.next_up()) && one.holds(2.0f64.next_down()) && !one.holds(2.0));
        assert!(!one.holds(f64::NAN) && !one.holds(f64::INFINITY));
        let below = Bounds::new(0.0f32, 1.0).exclusive_max().any_step();
        assert!(below.holds(0.0) && below.holds(1.0f32.next_down()) && !below.holds(1.0));
        // An end with a step: the end itself is refused, the steps past it hold.
        let cents = Bounds::new(0.0, 100.0).step(0.01).exclusive_min();
        assert!(!cents.holds(0.0) && cents.holds(0.01) && !cents.holds(0.005) && cents.holds(100.0));
        // Both ends excluded with min at max: nothing.
        assert!(!Bounds::new(1.0, 1.0).exclusive_min().any_step().holds(1.0));
    }

    #[test]
    fn a_number_that_reads_as_the_excluded_end_is_refused() {
        // 1e-50 is above 0, and the browser's double says so, but it reads as 0 in an f32.
        let above = Bounds::new(0.0f32, 1.0).exclusive_min().any_step();
        let tiny = super::super::Entry::<f32>::typed("1e-50");
        assert_eq!(tiny.value(), Some(0.0));
        assert_eq!(above.read(&tiny), None);
        assert_eq!(above.read(&super::super::Entry::typed("1e-45")), Some(1e-45));
        // A value that is no number, or not finite, does not read.
        assert_eq!(above.read(&super::super::Entry::typed("NaN")), None);
        assert_eq!(above.read(&super::super::Entry::typed("inf")), None);
        assert_eq!(above.read(&super::super::Entry::typed("1e39")), None);
    }

    #[test]
    fn the_spread_writes_min_max_and_step() {
        let mut out = String::new();
        Bounds::new(0.0, 10_000.0).step(0.01).render_attrs(&mut out);
        assert_eq!(out, r#" min="0" max="10000" step="0.01""#);
        out.clear();
        Bounds::new(-5i32, 5).render_attrs(&mut out);
        assert_eq!(out, r#" min="-5" max="5" step="1""#);
        out.clear();
        // With no step an exclusive end is drawn as the end itself: HTML has no exclusive min or max.
        Bounds::new(0.0, 1.0).exclusive_min().exclusive_max().any_step().render_attrs(&mut out);
        assert_eq!(out, r#" min="0" max="1" step="any""#);
    }

    #[test]
    fn a_stepped_exclusive_end_is_drawn_as_the_step_inside_it() {
        let drawn = |bounds: Bounds<f64>| {
            let mut out = String::new();
            bounds.render_attrs(&mut out);
            (out, bounds.drawn())
        };
        let quarters = Bounds::new(0.0, 1.0).step(0.25).exclusive_min().exclusive_max();
        assert_eq!(drawn(quarters), (r#" min="0.25" max="0.75" step="0.25""#.to_string(), (0.25, 0.75)));
        // Each drawn end is one the bounds hold, and the ends themselves are not.
        assert!(quarters.holds(0.25) && quarters.holds(0.75) && !quarters.holds(0.0) && !quarters.holds(1.0));
        let cents = Bounds::new(0.0, 100.0).step(0.01).exclusive_min();
        assert_eq!(drawn(cents), (r#" min="0.01" max="100" step="0.01""#.to_string(), (0.01, 100.0)));
        // A max off the steps: the last step below it, as for an inclusive one.
        let off = Bounds::new(-1.5, 0.9).step(0.5).exclusive_min().exclusive_max();
        assert_eq!(drawn(off), (r#" min="-1" max="0.5" step="0.5""#.to_string(), (-1.0, 0.5)));
        assert_eq!(drawn(Bounds::new(-1.0, 0.0).step(0.5).exclusive_max()).0, r#" min="-1" max="-0.5" step="0.5""#);
        let tens = Bounds::new(0.0, 1e3).step(10.0).exclusive_min().exclusive_max();
        assert_eq!(drawn(tens), (r#" min="10" max="990" step="10""#.to_string(), (10.0, 990.0)));
        let tenths = Bounds::new(0.0f32, 16.0).step(0.1).exclusive_min();
        let mut out = String::new();
        tenths.render_attrs(&mut out);
        assert_eq!((out.as_str(), tenths.drawn()), (r#" min="0.1" max="16" step="0.1""#, (0.1, 16.0)));
        // Inclusive ends and no step are drawn as they are.
        assert_eq!(drawn(Bounds::new(0.0, 1.0).step(0.25)).1, (0.0, 1.0));
        assert_eq!(drawn(Bounds::new(0.0, 1.0).exclusive_min().any_step()).1, (0.0, 1.0));
        // No step fits inside: the drawn min is above the drawn max, so the browser sends nothing,
        // as the bounds hold nothing.
        let none = Bounds::new(0.0, 0.25).step(0.25).exclusive_min().exclusive_max();
        assert_eq!(drawn(none).0, r#" min="0.25" max="0" step="0.25""#);
        assert!(!none.holds(0.0) && !none.holds(0.25));
        // Digits that do not line up in an i128: the end itself, which these bounds refuse even
        // when it is inclusive, as they do every value near it (the 38-digit limit above).
        let wide = Bounds::new(1e30, 2e30).step(1e-9);
        assert_eq!(drawn(wide.exclusive_min()).1, (1e30, 2e30));
        assert!(!wide.holds(1e30) && !wide.holds(1e30f64.next_up()));
    }

    #[test]
    fn a_step_finer_than_the_type_near_an_exclusive_end_is_drawn_where_it_reads_inside() {
        // 1.00000001 reads as 1.0 in an f32, the end refused: the first step that reads above it is
        // drawn, and the bounds hold it.
        let fine = Bounds::new(1.0f32, 2.0).step(1e-8).exclusive_min().exclusive_max();
        let mut out = String::new();
        fine.render_attrs(&mut out);
        let (min, max) = fine.drawn();
        assert!(min > 1.0 && max < 2.0 && fine.holds(min) && fine.holds(max), "{out} {min} {max}");
        assert_eq!(out, r#" min="1.00000006" max="1.99999994" step="0.00000001""#);
        assert_eq!(min, "1.00000006".parse::<f32>().unwrap());
        // An exclusive min with no finite max: the first step is drawn all the same.
        let open = Bounds::new(0.0, f64::INFINITY).step(0.01).exclusive_min();
        assert_eq!(open.drawn().0, 0.01);
        assert!(open.holds(0.01) && !open.holds(0.0));
        // An end whose decimal (`1.2`, the steps' origin) is below the float it reads as: the
        // first step that reads above that float, eleven steps on.
        let offset = Bounds::new(1.2f32, 2.0).step(1e-8).exclusive_min();
        let mut out = String::new();
        offset.render_attrs(&mut out);
        assert_eq!(out, r#" min="1.20000011" max="2" step="0.00000001""#);
        assert!(offset.drawn().0 > 1.2 && offset.holds(offset.drawn().0) && !offset.holds(1.2));
        // A step 60 times finer than the float tells apart at 1.
        let finer = Bounds::new(1.0f32, 2.0).step(1e-9).exclusive_min();
        let mut out = String::new();
        finer.render_attrs(&mut out);
        assert_eq!(out, r#" min="1.00000006" max="2" step="0.000000001""#);
        assert!(finer.drawn().0 > 1.0 && finer.holds(finer.drawn().0) && !finer.holds(1.0));
        // A max that reads as the min (`1.00000002` is `1` in an f32): the range is empty, and
        // so is the drawn one, min above max, which the browser sends nothing from.
        let none = Bounds::new(1.0f32, 1.00000002).step(1e-8).exclusive_min();
        let (min, max) = none.drawn();
        assert!(min > max && !none.holds(min) && !none.holds(max), "{min} {max}");
    }

    #[test]
    fn a_value_is_shown_with_its_steps_decimals() {
        assert_eq!(12.5f64.shown(0.01), "12.50");
        assert_eq!(0.5f64.shown(0.1), "0.5");
        assert_eq!(3.0f64.shown(1.0), "3");
        assert_eq!(7u32.shown(1), "7");
    }
}
