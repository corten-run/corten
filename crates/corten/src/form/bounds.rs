//! A number field's allowed values, written once for the input and the handler.

use crate::view::{Attrs, Render};

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
/// [`Bounds::any_step`], HTML's `step="any"`: a `Bounds<T, AnyStep>`, which holds every finite
/// number from `min` to `max`. Its ends, and only its, can be refused ("above 0", "below 1"):
/// [`exclusive_min`](Bounds::exclusive_min) and [`exclusive_max`](Bounds::exclusive_max). HTML
/// has no exclusive `min` or `max`, so the input says the type's next number inside the end
/// (`5e-324` above 0 in an `f64`), which the browser checks a typed value against and its arrow
/// keys never step past, and the handler's message, the app's, says "above". Each number the
/// input says is the shortest decimal that reads back as it, in exponent form where written out
/// it would take more than 18 digits, which Chromium and WebKit do not read exactly:
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Listing { discount: Entry<f64> }
///
/// /// A percentage off, as precise as the seller likes: above 0 and below 100.
/// const DISCOUNT: Bounds<f64, AnyStep> = Bounds::any_step(0.0, 100.0).exclusive_min().exclusive_max();
///
/// let f = Listing::FIELDS;
/// let view = html! { <input type="number" name={f.discount} {..DISCOUNT}> };
/// assert_eq!(
///     view.to_html(),
///     r#"<input type="number" name="discount" min="5e-324" max="99.99999999999999" step="any">"#
/// );
///
/// assert!(DISCOUNT.holds(37.5) && DISCOUNT.holds(5e-324));
/// assert!(!DISCOUNT.holds(0.0) && !DISCOUNT.holds(100.0));
/// assert_eq!((DISCOUNT.min(), DISCOUNT.max()), (0.0, 100.0));
/// ```
///
/// Bounds with a step stay off an end by starting a step inside it, as a count does:
/// `Bounds::new(1, 9)` is above 0, and `Bounds::new(0.1, 16.0).step(0.1)` above 0 in tenths. So
/// an exclusive end on them does not compile, nor a step on any-step bounds:
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// const WEIGHT: Bounds<f64> = Bounds::new(0.0, 16.0).step(0.1).exclusive_min();
/// ```
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// const RATIO: Bounds<f64, AnyStep> = Bounds::any_step(0.0, 1.0).step(0.1);
/// ```
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// const COPIES: Bounds<u32> = Bounds::new(0, 3).exclusive_min();
/// ```
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// const COPIES: Bounds<i64> = Bounds::new(-3, 3).exclusive_max();
/// ```
///
/// Any step is a float's alone: a number input with `step="any"` would send `2.5`, which no
/// integer reads:
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// const COPIES: Bounds<u32, AnyStep> = Bounds::any_step(0, 3);
/// ```
///
/// And `any_step` starts the bounds, so a step cannot be set and then dropped:
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const RATIO: Bounds<f64, AnyStep> = Bounds::new(0.0, 1.0).step(0.1).any_step();
/// ```
///
/// A step not above zero holds nothing, so every value is refused: a browser ignores such a step
/// and steps by 1, and the handler must not agree to values the input never offered. Any-step
/// bounds that hold no number, `min` above `max` or an exclusive `min` at the type's largest
/// number (whose next is infinite, and a browser ignores `min="inf"`), are drawn as the empty
/// range `min="1" max="0"`.
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
pub struct Bounds<T, S = T> {
    min: T,
    max: T,
    /// The step, a `T`, or [`AnyStep`].
    step: S,
    /// Whether `min` and `max` themselves are refused: with [`AnyStep`] alone.
    above: bool,
    below: bool,
}

impl<T: Numeric> Bounds<T> {
    /// Whole steps of 1 from `min` to `max`, both included. A `min` above `max` holds nothing.
    pub const fn new(min: T, max: T) -> Self {
        Bounds { min, max, step: T::ONE, above: false, below: false }
    }

    pub const fn step_size(&self) -> T {
        self.step
    }
}

impl<T: Numeric> Bounds<T, AnyStep> {
    /// Every number from `min` to `max`, both included, with as many decimals as are typed: the
    /// input's `step="any"`, for a float alone.
    pub const fn any_step(min: T, max: T) -> Self
    where
        T: Float,
    {
        Bounds { min, max, step: AnyStep, above: false, below: false }
    }
}

impl<T: Numeric, S: Spacing<T>> Bounds<T, S> {
    /// Steps of `step` from `min`: `0.01` for cents, `5` for a count in fives.
    pub const fn step(self, step: T) -> Bounds<T>
    where
        S: Stepped,
    {
        Bounds { min: self.min, max: self.max, step, above: false, below: false }
    }

    /// Refuses `min` itself: "above 0". The input says the type's next number above it.
    pub const fn exclusive_min(self) -> Self
    where
        S: Exclusive,
    {
        Bounds { min: self.min, max: self.max, step: self.step, above: true, below: self.below }
    }

    /// Refuses `max` itself: "below 1". The input says the type's next number below it.
    pub const fn exclusive_max(self) -> Self
    where
        S: Exclusive,
    {
        Bounds { min: self.min, max: self.max, step: self.step, above: self.above, below: true }
    }

    pub const fn min(&self) -> T {
        self.min
    }

    pub const fn max(&self) -> T {
        self.max
    }

    /// The step, `None` for [`any_step`](Bounds::any_step): what corten-ui's `NumberField` steps
    /// by.
    #[doc(hidden)]
    pub fn step_or_any(&self) -> Option<T> {
        self.step.size()
    }

    /// What a typed field reads as when it is a number these bounds hold: `None` when it is blank,
    /// does not read, or is out of bounds, each of which the handler answers with the field's
    /// message.
    pub fn read(&self, entry: &super::Entry<T>) -> Option<T> {
        entry.value().filter(|&v| self.holds(v))
    }

    /// Whether `value` is from `min` to `max` (off a refused end) and a whole number of steps
    /// from `min`, or with any step a finite number: what a browser checks before it sends the
    /// form, checked again by the handler.
    pub fn holds(&self, value: T) -> bool {
        S::holds(self, value)
    }
}

impl<T: Numeric, S: Spacing<T>> Attrs for Bounds<T, S> {
    fn render_attrs(&self, out: &mut String) {
        <S as Spacing<T>>::render_attrs(self, out)
    }
}

impl<T: Numeric, S: Spacing<T>> crate::view::__private::Writes for Bounds<T, S> {
    type Static = Self;
    const WRITES: &'static [&'static str] = &["min", "max", "step"];
}

/// The spacing of a [`Bounds`]' values: a step, a `T` ([`Bounds::new`]), or [`AnyStep`]
/// ([`Bounds::any_step`]). Sealed.
pub trait Spacing<T: Numeric>: Copy + sealed::Sealed + 'static {
    #[doc(hidden)]
    fn holds(bounds: &Bounds<T, Self>, value: T) -> bool;
    #[doc(hidden)]
    fn render_attrs(bounds: &Bounds<T, Self>, out: &mut String);
    /// The step, `None` for any step.
    #[doc(hidden)]
    fn size(self) -> Option<T>;
}

impl<T: Numeric> Spacing<T> for T {
    #[inline]
    fn holds(bounds: &Bounds<T>, value: T) -> bool {
        let Bounds { min, max, step, .. } = *bounds;
        min <= value && value <= max && T::ZERO < step && value.on_step(min, step)
    }

    fn render_attrs(bounds: &Bounds<T>, out: &mut String) {
        number_attr(" min", bounds.min, out);
        number_attr(" max", bounds.max, out);
        number_attr(" step", bounds.step, out);
    }

    fn size(self) -> Option<T> {
        Some(self)
    }
}

/// HTML's `step="any"`: the spacing of [`Bounds::any_step`], every float from `min` to `max`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnyStep;

impl sealed::Sealed for AnyStep {}

impl<T: Float> Spacing<T> for AnyStep {
    fn holds(bounds: &Bounds<T, AnyStep>, value: T) -> bool {
        let above = if bounds.above { bounds.min < value } else { bounds.min <= value };
        let below = if bounds.below { value < bounds.max } else { value <= bounds.max };
        // A finite number in range: an infinite `max` does not hold infinity.
        above && below && value.is_finite()
    }

    fn render_attrs(bounds: &Bounds<T, AnyStep>, out: &mut String) {
        // HTML has no exclusive `min` or `max`: a refused end is drawn as the type's next number
        // inside it, which the browser's range check and arrow keys then keep inside.
        let min = if bounds.above { bounds.min.next(true) } else { bounds.min };
        let max = if bounds.below { bounds.max.next(false) } else { bounds.max };
        // No number from `min` to `max`: past the type's largest number the next is infinite (or
        // an end is NaN), and a browser ignores a `min` or `max` it cannot read, so it would take
        // what the handler refuses. A range with nothing in it says so instead.
        let empty = match min.partial_cmp(&max) {
            Some(std::cmp::Ordering::Less) => false,
            Some(std::cmp::Ordering::Equal) => !min.is_finite(),
            _ => true,
        };
        if empty {
            out.push_str(r#" min="1" max="0" step="any""#);
            return;
        }
        number_attr(" min", min, out);
        number_attr(" max", max, out);
        out.push_str(r#" step="any""#);
    }

    fn size(self) -> Option<T> {
        None
    }
}

/// Bounds with a step, which [`step`](Bounds::step) sets. Sealed.
#[diagnostic::on_unimplemented(
    message = "bounds with any step have no step to set",
    label = "these bounds take every number in range",
    note = "a field with a step is `Bounds::new(min, max).step(..)`, and one with none `Bounds::any_step(min, max)`"
)]
pub trait Stepped: sealed::Sealed {}

impl<T: Numeric> Stepped for T {}

/// Bounds whose ends can be refused: [`Bounds::any_step`]'s alone. Sealed.
#[diagnostic::on_unimplemented(
    message = "bounds with a step include both ends",
    label = "only `Bounds::any_step` refuses an end",
    note = "a step stays off an end by starting a step inside it: `Bounds::new(0.1, 16.0).step(0.1)` is above 0 in tenths, `Bounds::new(1, 9)` above 0"
)]
pub trait Exclusive: sealed::Sealed {}

impl Exclusive for AnyStep {}

/// A float, whose [`Bounds`] can be [`any_step`](Bounds::any_step). Sealed.
#[diagnostic::on_unimplemented(
    message = "`{Self}` is a whole number: its bounds have a step",
    label = "a float's bounds alone take any step",
    note = "a number input with `step=\"any\"` sends `2.5`, which no whole number reads"
)]
pub trait Float: Numeric {
    /// Not an infinity or NaN.
    #[doc(hidden)]
    fn is_finite(self) -> bool;
    /// The type's next number above `self` (`up`) or below it.
    #[doc(hidden)]
    fn next(self, up: bool) -> Self;
}

/// Writes ` name="…"` with `value` as an input's number ([`Numeric::write_value`]).
pub(super) fn number_attr<T: Numeric>(name: &str, value: T, out: &mut String) {
    out.push_str(name);
    out.push_str("=\"");
    value.write_value(out);
    out.push('"');
}

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
    /// `self` as an input's value, with the decimals of `step`: `12.5` in steps of `0.01` is
    /// `12.50`. A whole number as it is.
    #[doc(hidden)]
    fn shown(self, step: Self) -> String;
    /// Writes `self` as an input's number (a `min`, or a `value` made in code): the shortest
    /// decimal that reads back as it, in exponent form where written out it would take more than
    /// 18 digits (`1e-20`, not `0.00000000000000000001`), which Chromium and WebKit read as a
    /// different number. A whole number as it is.
    #[doc(hidden)]
    fn write_value(self, out: &mut String) {
        self.render(out)
    }
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
        impl Float for $t {
            fn is_finite(self) -> bool {
                <$t>::is_finite(self)
            }
            fn next(self, up: bool) -> Self {
                if up { self.next_up() } else { self.next_down() }
            }
        }
        impl Numeric for $t {
            const ZERO: Self = 0.0;
            const ONE: Self = 1.0;
            fn write_value(self, out: &mut String) {
                // Written out first, as most numbers are short. Measured on 6,222 numbers, each
                // between the doubles next to it: Chromium and WebKit took every one written out
                // in up to 19 digits and refused about half of those in 20 or more; in exponent
                // form, none. Firefox took them all.
                let start = out.len();
                self.render(out);
                if out.as_bytes()[start..].iter().filter(|b| b.is_ascii_digit()).count() > 18 {
                    use std::fmt::Write;
                    out.truncate(start);
                    // Digits, a point, `e` and `-`: nothing to escape.
                    let _ = write!(out, "{self:e}");
                }
            }
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
    use crate::view::AttrValue;

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
        let ratio = Bounds::any_step(0.0, 1.0);
        assert!(ratio.holds(0.0) && ratio.holds(0.375) && ratio.holds(1.0 / 3.0) && ratio.holds(1.0));
        assert!(!ratio.holds(-0.000_001) && !ratio.holds(1.000_000_1));
        assert!(!ratio.holds(f64::NAN) && !ratio.holds(f64::INFINITY) && !ratio.holds(f64::NEG_INFINITY));
        // An infinite end does not let infinity through.
        let open = Bounds::any_step(f64::NEG_INFINITY, f64::INFINITY);
        assert!(open.holds(f64::MAX) && open.holds(f64::MIN) && !open.holds(f64::INFINITY) && !open.holds(f64::NEG_INFINITY));
        assert!(!Bounds::any_step(1.0f32, 0.0).holds(0.5));
        assert_eq!(ratio.step_or_any(), None);
        assert_eq!(Bounds::new(0.0, 1.0).step(0.25).step_or_any(), Some(0.25));
    }

    #[test]
    fn an_exclusive_end_refuses_the_end_and_holds_the_next_number() {
        let above = Bounds::any_step(0.0, 10.0).exclusive_min();
        assert!(!above.holds(0.0) && !above.holds(-0.0));
        // The smallest f64 above zero reads from a form and holds.
        let least = super::super::Entry::<f64>::typed("5e-324");
        assert_eq!(least.value(), Some(5e-324));
        assert_eq!(above.read(&least), Some(5e-324));
        assert!(above.holds(10.0));
        let one = Bounds::any_step(1.0, 2.0).exclusive_min().exclusive_max();
        assert!(!one.holds(1.0) && one.holds(1.0f64.next_up()) && one.holds(2.0f64.next_down()) && !one.holds(2.0));
        assert!(!one.holds(f64::NAN) && !one.holds(f64::INFINITY));
        let below = Bounds::any_step(0.0f32, 1.0).exclusive_max();
        assert!(below.holds(0.0) && below.holds(1.0f32.next_down()) && !below.holds(1.0));
        // Both ends refused with min at max: nothing.
        assert!(!Bounds::any_step(1.0, 1.0).exclusive_min().exclusive_max().holds(1.0));
    }

    #[test]
    fn a_number_that_reads_as_the_excluded_end_is_refused() {
        // 1e-50 is above 0, and the browser's double says so, but it reads as 0 in an f32.
        let above = Bounds::any_step(0.0f32, 1.0).exclusive_min();
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
        Bounds::any_step(0.0, 1.0).render_attrs(&mut out);
        assert_eq!(out, r#" min="0" max="1" step="any""#);
    }

    #[test]
    fn a_refused_end_is_drawn_as_the_types_next_number_inside_it() {
        fn drawn(bounds: impl Attrs) -> String {
            let mut out = String::new();
            bounds.render_attrs(&mut out);
            out
        }
        let percent = Bounds::any_step(0.0, 100.0).exclusive_min().exclusive_max();
        assert_eq!(drawn(percent), r#" min="5e-324" max="99.99999999999999" step="any""#);
        assert_eq!(drawn(Bounds::any_step(-1.0, 1.0).exclusive_min()), r#" min="-0.9999999999999999" max="1" step="any""#);
        let ratio = Bounds::any_step(0.0f32, 1.0).exclusive_min().exclusive_max();
        assert_eq!(drawn(ratio), r#" min="1e-45" max="0.99999994" step="any""#);
        // Each drawn end, sent back as the browser writes it, reads and holds, where the end itself
        // does not: the browser's range check and the handler's agree at the ends.
        let attr = |out: &str, name: &str| {
            out.split(&format!(" {name}=\"")).nth(1).and_then(|rest| rest.split('"').next()).map(String::from)
        };
        for bounds in [percent, Bounds::any_step(-1.0, 1.0), Bounds::any_step(1e300, f64::MAX), Bounds::any_step(-5e-324, 5e-324)]
        {
            let bounds = bounds.exclusive_min().exclusive_max();
            let out = drawn(bounds);
            for name in ["min", "max"] {
                let sent = attr(&out, name).unwrap();
                let read = bounds.read(&super::super::Entry::typed(&sent));
                assert!(read.is_some_and(|v| v != bounds.min() && v != bounds.max()), "{out} {name}");
            }
        }
        for name in ["min", "max"] {
            let sent = attr(&drawn(ratio), name).unwrap();
            assert!(ratio.read(&super::super::Entry::typed(&sent)).is_some(), "{sent}");
        }
    }

    #[test]
    fn bounds_that_hold_nothing_are_drawn_as_an_empty_range() {
        fn drawn(bounds: impl Attrs) -> String {
            let mut out = String::new();
            bounds.render_attrs(&mut out);
            out
        }
        const EMPTY: &str = r#" min="1" max="0" step="any""#;
        // Past the type's largest number the next is infinite, and a browser ignores `min="inf"`:
        // it would take `1`, which the handler refuses.
        let above_max = Bounds::any_step(f64::MAX, f64::MAX).exclusive_min();
        assert_eq!(drawn(above_max), EMPTY);
        assert!(!above_max.holds(f64::MAX) && !above_max.holds(1.0));
        let below_min = Bounds::any_step(f64::MIN, f64::MIN).exclusive_max();
        assert_eq!(drawn(below_min), EMPTY);
        assert!(!below_min.holds(f64::MIN) && !below_min.holds(-1.0));
        assert_eq!(drawn(Bounds::any_step(f32::MAX, f32::MAX).exclusive_min()), EMPTY);
        assert_eq!(drawn(Bounds::any_step(f32::MIN, f32::MIN).exclusive_max()), EMPTY);
        assert_eq!(drawn(Bounds::any_step(1.0, 1.0).exclusive_min()), EMPTY);
        assert_eq!(drawn(Bounds::any_step(1.0f32, 0.0)), EMPTY);
        assert_eq!(drawn(Bounds::any_step(f64::NAN, 1.0)), EMPTY);
        assert!(!Bounds::any_step(f32::MAX, f32::MAX).exclusive_min().holds(f32::MAX));
        // At the largest number, included, its one number is drawn in exponent form.
        assert_eq!(
            drawn(Bounds::any_step(f64::MAX, f64::MAX)),
            r#" min="1.7976931348623157e308" max="1.7976931348623157e308" step="any""#
        );
        assert!(Bounds::any_step(f64::MAX, f64::MAX).holds(f64::MAX));
        // Infinite ends, which a browser ignores as the handler holds every finite number.
        let open = Bounds::any_step(f64::NEG_INFINITY, f64::INFINITY);
        assert_eq!(drawn(open), r#" min="-inf" max="inf" step="any""#);
        assert_eq!(drawn(open.exclusive_min()), r#" min="-1.7976931348623157e308" max="inf" step="any""#);
    }

    #[test]
    fn a_number_past_18_digits_written_out_is_written_with_an_exponent() {
        let written = |v: &dyn Fn(&mut String)| {
            let mut out = String::new();
            v(&mut out);
            out
        };
        assert_eq!(written(&|o| 37.5f64.write_value(o)), "37.5");
        assert_eq!(written(&|o| 0.1f64.write_value(o)), "0.1");
        assert_eq!(written(&|o| 1e-17f64.write_value(o)), "0.00000000000000001");
        assert_eq!(written(&|o| 1e-18f64.write_value(o)), "1e-18");
        assert_eq!(written(&|o| 1e-20f64.write_value(o)), "1e-20");
        assert_eq!(written(&|o| (-1e-20f64).write_value(o)), "-1e-20");
        assert_eq!(written(&|o| 1e-20f32.write_value(o)), "1e-20");
        assert_eq!(written(&|o| 0.30000000000000004f64.write_value(o)), "0.30000000000000004");
        assert_eq!(written(&|o| 0.12345678901234568f64.write_value(o)), "0.12345678901234568");
        assert_eq!(written(&|o| 1.2345678901234568e-5f64.write_value(o)), "1.2345678901234568e-5");
        assert_eq!(written(&|o| 1e17f64.write_value(o)), "100000000000000000");
        assert_eq!(written(&|o| 1e18f64.write_value(o)), "1e18");
        assert_eq!(written(&|o| u64::MAX.write_value(o)), "18446744073709551615");
        // Each reads back as the same number.
        for v in [1e-20, 1.2345678901234568e-5, 5e-324, f64::MAX, -1e-300, 1.5e25] {
            assert_eq!(written(&|o| v.write_value(o)).parse::<f64>(), Ok(v));
        }
        // A number made in code is written so in an input's `value`; a typed one as typed.
        let mut out = String::new();
        super::super::Entry::from(1e-20).write_attr(" value", &mut out);
        super::super::Entry::<f64>::typed("0.00000000000000000001").write_attr(" value", &mut out);
        assert_eq!(out, r#" value="1e-20" value="0.00000000000000000001""#);
    }

    #[test]
    fn a_value_is_shown_with_its_steps_decimals() {
        assert_eq!(12.5f64.shown(0.01), "12.50");
        assert_eq!(0.5f64.shown(0.1), "0.5");
        assert_eq!(3.0f64.shown(1.0), "3");
        assert_eq!(7u32.shown(1), "7");
    }
}
