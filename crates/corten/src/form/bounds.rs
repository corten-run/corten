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
/// #[derive(serde::Deserialize, Fields)]
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
/// the step, and a value more than 10^30 steps from `min` is refused.
/// A field has both ends: the server checks a value it was sent against both, so the input says
/// them too.
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
    step: T,
}

impl<T: Numeric> Bounds<T> {
    /// Whole steps of 1 from `min` to `max`. A `min` above `max` holds nothing.
    pub const fn new(min: T, max: T) -> Self {
        Bounds { min, max, step: T::ONE }
    }

    /// Steps of `step` from `min`: `0.01` for cents, `5` for a count in fives.
    pub const fn step(self, step: T) -> Self {
        Bounds { min: self.min, max: self.max, step }
    }

    pub const fn min(&self) -> T {
        self.min
    }

    pub const fn max(&self) -> T {
        self.max
    }

    pub const fn step_size(&self) -> T {
        self.step
    }

    /// Whether `value` is from `min` to `max` and a whole number of steps from `min`: what a
    /// browser checks before it sends the form, checked again by the handler.
    pub fn holds(&self, value: T) -> bool {
        self.min <= value && value <= self.max && T::ZERO < self.step && value.on_step(self.min, self.step)
    }
}

impl<T: Numeric> Attrs for Bounds<T> {
    fn render_attrs(&self, out: &mut String) {
        quoted(" min", &self.min, out);
        quoted(" max", &self.max, out);
        quoted(" step", &self.step, out);
    }
}

impl<T: Numeric> crate::view::__private::Writes for Bounds<T> {
    type Static = Self;
    const WRITES: &'static [&'static str] = &["min", "max", "step"];
}

/// A number a [`Bounds`] holds: an integer or a float. Sealed.
#[diagnostic::on_unimplemented(message = "a number field reads an integer or a float, not `{Self}`")]
pub trait Numeric: Copy + PartialOrd + Render + std::fmt::Debug + sealed::Sealed + 'static {
    #[doc(hidden)]
    const ZERO: Self;
    #[doc(hidden)]
    const ONE: Self;
    /// Whether `self`, at least `from`, is a whole number of `step`s (above zero) from it.
    #[doc(hidden)]
    fn on_step(self, from: Self, step: Self) -> bool;
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
        impl Numeric for $t {
            const ZERO: Self = 0.0;
            const ONE: Self = 1.0;
            fn on_step(self, from: Self, step: Self) -> bool {
                // The steps nearest the value, each written in decimal as a browser would have
                // it typed and read back as this type: the value is on a step when one reads as it.
                let (Some(value), Some(from_at), Some(step_at)) = (Decimal::of(self), Decimal::of(from), Decimal::of(step)) else {
                    return false;
                };
                // The nearest step exactly, in decimal, where the digits line up in an `i128`;
                // else estimated in f64, which past 2^53 steps is near enough to try either side.
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
    fn steps_too_many_to_count_are_refused() {
        assert!(!Bounds::new(0.0, f64::MAX).step(1e-9).holds(1e30));
        assert!(!Bounds::new(0.0, f64::MAX).holds(1e300));
        assert!(!Bounds::new(f64::MIN, f64::MAX).holds(f64::INFINITY));
        assert!(!Bounds::new(0.0, 1.0).step(0.1).holds(f64::NAN));
        assert!(Bounds::new(0.0, 1.0).step(5e-324).holds(5e-324));
    }

    #[test]
    fn the_spread_writes_min_max_and_step() {
        let mut out = String::new();
        Bounds::new(0.0, 10_000.0).step(0.01).render_attrs(&mut out);
        assert_eq!(out, r#" min="0" max="10000" step="0.01""#);
        out.clear();
        Bounds::new(-5i32, 5).render_attrs(&mut out);
        assert_eq!(out, r#" min="-5" max="5" step="1""#);
    }

    #[test]
    fn a_value_is_shown_with_its_steps_decimals() {
        assert_eq!(12.5f64.shown(0.01), "12.50");
        assert_eq!(0.5f64.shown(0.1), "0.5");
        assert_eq!(3.0f64.shown(1.0), "3");
        assert_eq!(7u32.shown(1), "7");
    }
}
