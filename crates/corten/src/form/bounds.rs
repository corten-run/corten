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
/// The field's own type reads the number: a number input sends one or nothing (a blank field,
/// `None` for an `Option`), so a value that is not a number came from no form of the app's and is
/// refused before the handler runs. The message is the app's, as every rule's is. A decimal
/// field sets its step (`Bounds::new(0.0, 10_000.0).step(0.01)`); its check allows for the
/// rounding of binary floats, as a browser's does.
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

    /// Steps of `step` from `min`: `0.01` for cents, `5` for a count in fives. A step that is not
    /// above zero holds nothing.
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
#[diagnostic::on_unimplemented(message = "a number field's bounds are integers or floats, not `{Self}`")]
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
            #[inline]
            fn on_step(self, from: Self, step: Self) -> bool {
                // `0.3` over `0.01` is not exactly 30 steps in binary: allow the rounding of
                // the subtraction and the division, a few units in the last place of the values
                // over the step, and no more, so half a step is refused at any size.
                let steps = (self - from) / step;
                let slack = 8.0 * <$t>::EPSILON * ((self.abs() + from.abs()) / step).max(1.0);
                (steps - steps.round()).abs() <= slack
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
    fn a_step_not_above_zero_or_a_min_above_max_holds_nothing() {
        assert!(!Bounds::new(0u32, 10).step(0).holds(5));
        assert!(!Bounds::new(-10i32, 10).step(-1).holds(5));
        assert!(!Bounds::new(5u32, 1).holds(3));
        assert!(!Bounds::new(0.0, 1.0).step(0.0).holds(0.5));
    }

    #[test]
    fn decimals_hold_on_their_step_despite_binary_rounding() {
        let cents = Bounds::new(0.0, 10_000.0).step(0.01);
        assert!(cents.holds(0.3) && cents.holds(19.99) && cents.holds(10_000.0));
        assert!(!cents.holds(0.005) && !cents.holds(10_000.01) && !cents.holds(-0.01));
        assert!(!cents.holds(f64::NAN) && !cents.holds(f64::INFINITY));
        let big = Bounds::new(0.0, 1e12).step(0.01);
        assert!(big.holds(9_999_999.99) && !big.holds(9_999_999.995));
        let tenths = Bounds::new(0.1f32, 5.0).step(0.1);
        assert!(tenths.holds(0.3) && tenths.holds(5.0) && !tenths.holds(0.25));
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
