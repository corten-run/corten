//! A number field's allowed values, written once for the input and the handler.

use crate::view::{quoted, AttrValue, Attrs, Render};

/// The values a number field allows: from `min` to `max`, in steps of `step` counted from
/// `min` (1 unless set, as in HTML). One constant gives the input its `min`, `max` and `step`
/// (`{..COPIES}`) and the handler its check ([`Bounds::holds`]), so the rules are declared once:
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
/// `Bounds::<f64>::any_step` or `Bounds::<f32>::any_step`, HTML's `step="any"`: a
/// `Bounds<T, AnyStep>`, which holds every finite number from `min` to `max`. Its ends, and
/// only its, can be refused ("above 0", "below 1"): `exclusive_min` and `exclusive_max`. HTML
/// has no exclusive `min` or `max`, so the input gets the same endpoint as an inclusive bound.
/// Shifting the hint inward can block a value the server would accept. Native validation is
/// advisory; the handler's check is authoritative and refuses the endpoint itself:
///
/// ```
/// use corten::prelude::*;
///
/// #[derive(Fields)]
/// struct Listing { discount: Entry<f64> }
///
/// /// A percentage off, as precise as the seller likes: above 0 and below 100.
/// const DISCOUNT: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(0.0, 100.0).exclusive_min().exclusive_max();
///
/// let f = Listing::FIELDS;
/// let discount = Entry::from(1e-20);
/// let view = html! { <input type="number" name={f.discount} value={DISCOUNT.input_value(&discount)} {..DISCOUNT}> };
/// assert_eq!(
///     view.to_html(),
///     r#"<input type="number" name="discount" value="1e-20" min="0" max="100" step="any">"#
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
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const WEIGHT: Bounds<f64> = Bounds::new(0.0, 16.0).step(0.1).exclusive_min();
/// ```
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
///
/// const RATIO: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(0.0, 1.0).step(0.1);
/// ```
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const COPIES: Bounds<i64> = Bounds::new(-3, 3).exclusive_max();
/// ```
///
/// Any step is a float's alone: a number input with `step="any"` would send `2.5`, which no
/// integer reads:
///
/// ```compile_fail,E0599
/// use corten::prelude::*;
///
/// const COPIES: Bounds<u32, AnyStep> = Bounds::<u32>::any_step(0, 3);
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
/// and steps by 1, and the handler must not agree to values the input never offered.
///
/// Any-step bounds require finite, ordered ends and at least one representable value. The
/// notation used for native hints does not limit the logical range:
///
/// ```
/// use corten::prelude::*;
/// const LESS: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(0.0, 0.01).exclusive_max();
/// const MORE: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(0.01, 1.0).exclusive_min();
/// assert!(LESS.holds(0.01_f64.next_down()) && !LESS.holds(0.01));
/// assert!(MORE.holds(0.01_f64.next_up()) && !MORE.holds(0.01));
/// assert_eq!(html! { <input type="number" {..LESS}> }.to_html(),
///     r#"<input type="number" min="0" max="0.01" step="any">"#);
/// assert_eq!(html! { <input type="number" {..MORE}> }.to_html(),
///     r#"<input type="number" min="0.01" max="1" step="any">"#);
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const REVERSED: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(1.0, 0.0);
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const NAN: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(f64::NAN, 1.0);
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const INFINITY: Bounds<f32, AnyStep> = Bounds::<f32>::any_step(0.0, f32::INFINITY);
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const NEG_INFINITY: Bounds<f32, AnyStep> = Bounds::<f32>::any_step(f32::NEG_INFINITY, 0.0);
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const EMPTY: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(1.0, 1.0).exclusive_min();
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const ADJACENT: Bounds<f32, AnyStep> = Bounds::<f32>::any_step(1.0, 1.0_f32.next_up())
///     .exclusive_min().exclusive_max();
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const ABOVE_MAX: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(f64::MAX, f64::MAX).exclusive_min();
/// ```
///
/// ```compile_fail,E0080
/// use corten::prelude::*;
/// const BELOW_MIN: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(f64::MIN, f64::MIN).exclusive_max();
/// ```
///
/// The spread owns `min`, `max` and `step`, so a tag that writes one of them as well does
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
}

impl<T: Numeric> Bounds<T> {
    /// Whole steps of 1 from `min` to `max`, both included. A `min` above `max` holds nothing.
    pub const fn new(min: T, max: T) -> Self {
        Bounds { min, max, step: T::ONE }
    }

    pub const fn step_size(&self) -> T {
        self.step
    }
}

macro_rules! any_step {
    ($t:ty) => {
        impl Bounds<$t> {
            /// Every finite number from `min` to `max`, both included: HTML's `step="any"`.
            /// Panics if an end is not finite or `min > max`; a constant fails to compile.
            pub const fn any_step(min: $t, max: $t) -> Bounds<$t, AnyStep> {
                assert!(min.is_finite() && max.is_finite(), "any-step bounds require finite ends");
                assert!(min <= max, "any-step bounds must hold at least one number");
                Bounds { min, max, step: AnyStep { above: false, below: false } }
            }
        }

        impl Bounds<$t, AnyStep> {
            /// Refuses `min` itself on the server. The input's `min` hint is unchanged.
            /// Panics if this leaves no value; a constant fails to compile.
            pub const fn exclusive_min(mut self) -> Self {
                self.step.above = true;
                self.check_nonempty()
            }

            /// Refuses `max` itself on the server. The input's `max` hint is unchanged.
            /// Panics if this leaves no value; a constant fails to compile.
            pub const fn exclusive_max(mut self) -> Self {
                self.step.below = true;
                self.check_nonempty()
            }

            const fn check_nonempty(self) -> Self {
                let min = if self.step.above { self.min.next_up() } else { self.min };
                let max = if self.step.below { self.max.next_down() } else { self.max };
                assert!(min <= max, "any-step bounds must hold at least one number");
                self
            }
        }
    };
}
any_step!(f64);
any_step!(f32);

impl<T: Numeric, S: Spacing<T>> Bounds<T, S> {
    /// Steps of `step` from `min`: `0.01` for cents, `5` for a count in fives.
    pub const fn step(self, step: T) -> Bounds<T>
    where
        S: Stepped,
    {
        Bounds { min: self.min, max: self.max, step }
    }

    pub const fn min(&self) -> T {
        self.min
    }

    pub const fn max(&self) -> T {
        self.max
    }

    /// Whether corten-ui's `NumberField` has no step for its buttons.
    #[doc(hidden)]
    pub const fn is_any_step(&self) -> bool {
        S::ANY_STEP
    }

    /// The `value` of an `<input type="number">` using these bounds. Text sent back by a form
    /// stays as typed. A programmatic value is shown with the decimals of the minimum or step,
    /// whichever has more, or with any step,
    /// uses exponent notation if writing it out would take more than 18 digits. This avoids
    /// native validation problems with long fixed spellings. Like [`super::Entry`], this leaves
    /// out an unset value.
    #[inline]
    pub fn input_value<'a>(&self, entry: &'a super::Entry<T>) -> impl AttrValue + use<'a, T, S> {
        InputValue { entry, bounds: *self }
    }

    /// What a typed field reads as when it is a number these bounds hold: `None` when it is blank,
    /// does not read, or is out of bounds, each of which the handler answers with the field's
    /// message.
    pub fn read(&self, entry: &super::Entry<T>) -> Option<T> {
        entry.value().filter(|&v| self.holds(v))
    }

    /// Whether `value` is from `min` to `max` (off a refused end) and a whole number of steps
    /// from `min`, or with any step a finite number. This is the handler's check regardless of
    /// what native validation admitted.
    pub fn holds(&self, value: T) -> bool {
        S::holds(self, value)
    }
}

struct InputValue<'a, T, S> {
    entry: &'a super::Entry<T>,
    bounds: Bounds<T, S>,
}

impl<T: Numeric, S: Spacing<T>> AttrValue for InputValue<'_, T, S> {
    #[inline]
    fn write_attr(&self, name: &str, out: &mut String) {
        if let Some(text) = self.entry.text() {
            text.write_attr(name, out);
        } else if let Some(value) = self.entry.value() {
            self.bounds.step.write_value_attr_from(&self.bounds, name, value, out);
        }
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

/// The spacing of a [`Bounds`]' values: a step, a `T` ([`Bounds::new`]), or [`AnyStep`]. Sealed.
pub trait Spacing<T: Numeric>: Copy + sealed::Sealed + 'static {
    #[doc(hidden)]
    const ANY_STEP: bool;
    #[doc(hidden)]
    fn holds(bounds: &Bounds<T, Self>, value: T) -> bool;
    #[doc(hidden)]
    fn render_attrs(bounds: &Bounds<T, Self>, out: &mut String);
    #[doc(hidden)]
    fn write_value_attr(self, name: &str, value: T, out: &mut String);
    #[doc(hidden)]
    fn write_value_attr_from(self, _bounds: &Bounds<T, Self>, name: &str, value: T, out: &mut String) {
        self.write_value_attr(name, value, out);
    }
}

impl<T: Numeric> Spacing<T> for T {
    const ANY_STEP: bool = false;

    #[inline]
    fn holds(bounds: &Bounds<T>, value: T) -> bool {
        let Bounds { min, max, step, .. } = *bounds;
        min <= value && value <= max && T::ZERO < step && value.on_step(min, step)
    }

    fn render_attrs(bounds: &Bounds<T>, out: &mut String) {
        quoted(" min", &bounds.min, out);
        quoted(" max", &bounds.max, out);
        quoted(" step", &bounds.step, out);
    }

    fn write_value_attr(self, name: &str, value: T, out: &mut String) {
        quoted(name, &value.shown(self), out);
    }

    fn write_value_attr_from(self, bounds: &Bounds<T>, name: &str, value: T, out: &mut String) {
        quoted(name, &value.shown_from(bounds.min, Some(bounds.max), self), out);
    }
}

/// HTML's `step="any"`: any float from `min` to `max`, off an exclusive end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnyStep {
    above: bool,
    below: bool,
}

impl sealed::Sealed for AnyStep {}

impl<T: Float> Spacing<T> for AnyStep {
    const ANY_STEP: bool = true;

    fn holds(bounds: &Bounds<T, AnyStep>, value: T) -> bool {
        let above = if bounds.step.above { bounds.min < value } else { bounds.min <= value };
        let below = if bounds.step.below { value < bounds.max } else { value <= bounds.max };
        above && below
    }

    fn render_attrs(bounds: &Bounds<T, AnyStep>, out: &mut String) {
        number_attr(" min", bounds.min, out);
        number_attr(" max", bounds.max, out);
        out.push_str(r#" step="any""#);
    }

    fn write_value_attr(self, name: &str, value: T, out: &mut String) {
        number_attr(name, value, out);
    }
}

/// Bounds with a step, which [`step`](Bounds::step) sets. Sealed.
#[diagnostic::on_unimplemented(
    message = "bounds with any step have no step to set",
    label = "these bounds take every number in range",
    note = "a field with a step is `Bounds::new(min, max).step(..)`, and one with none `Bounds::<f64>::any_step(min, max)`"
)]
pub trait Stepped: sealed::Sealed {}

impl<T: Numeric> Stepped for T {}

trait Float: Numeric {
    fn write_value(self, out: &mut String);
}

fn number_attr<T: Float>(name: &str, value: T, out: &mut String) {
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
    #[doc(hidden)]
    fn shown_from(self, _min: Self, _max: Option<Self>, step: Self) -> String {
        self.shown(step)
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
    ($($t:ty => $safe_digits:literal),*) => {$(
        impl sealed::Sealed for $t {}
        impl Float for $t {
            fn write_value(self, out: &mut String) {
                // Written out unless that would take more than 18 digits. Measured on 6,222 numbers,
                // each between the doubles next to it: Chromium and WebKit took every one written
                // out in up to 19 digits and refused about half of those in 20 or more; in exponent
                // form, none. Firefox took them all. From 0.1 to below 1e18 (the shortest decimal
                // has at most 17 significant digits) a number is at most 18 digits written out, so
                // most are written at once; past that range the exponent form is written first, as
                // it is short (`5e-324`, where written out is 326 characters), and the length
                // written out follows from its digits and exponent.
                let size = self.abs();
                if size == 0.0 || (0.1..1e18).contains(&size) || !<$t>::is_finite(self) {
                    self.render(out);
                    return;
                }
                use std::fmt::Write;
                let start = out.len();
                // Digits, a point, `e` and `-`: nothing to escape.
                let _ = write!(out, "{self:e}");
                let text = &out[start..];
                let Some((mantissa, exponent)) = text.split_once('e') else { return };
                let Ok(exponent) = exponent.parse::<i32>() else { return };
                let digits = mantissa.bytes().filter(u8::is_ascii_digit).count() as i32;
                // `d.ddd` times ten to `exponent`, written out: the digits and the zeros a whole
                // number ends with, or `0.` and the zeros before the first digit.
                let written_out = if exponent >= 0 { digits.max(exponent + 1) } else { digits - exponent };
                if written_out <= 18 {
                    out.truncate(start);
                    self.render(out);
                }
            }
        }
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
                let Some(near) = value.near_step(from_at, step_at, || (self as f64 - from as f64) / step as f64) else {
                    return false;
                };
                from_at.step_candidates(step_at, near, [-1, 0, 1]).any(|point| point.reads_as(self))
            }
            fn shown(self, step: Self) -> String {
                self.shown_from(0.0, None, step)
            }
            fn shown_from(self, min: Self, max: Option<Self>, step: Self) -> String {
                use std::fmt::Write;
                let mut text = String::new();
                let mut decimals = 0;
                for n in [step, min] {
                    if n.trunc() != n {
                        text.clear();
                        write!(text, "{n}").unwrap();
                        if let Some((_, fraction)) = text.split_once('.') {
                            decimals = decimals.max(fraction.len());
                        }
                    }
                }
                text.clear();
                write!(text, "{self:.decimals$}").unwrap();
                // With this many fixed digits (excluding sign and point), a float's rounding
                // error is less than half the final decimal place. A grid point that reads back
                // as this float must already be the spelling we wrote.
                if text.len() <= $safe_digits + usize::from(decimals != 0) + usize::from(self.is_sign_negative()) {
                    return text;
                }
                if let Some(max) = max {
                    prefer_step_decimal(&mut text, self, Bounds { min, max, step }, || (self as f64 - min as f64) / step as f64);
                }
                text
            }
        }
    )*};
}
float!(f32 => 6, f64 => 15);

#[cold]
fn prefer_step_decimal<T: Numeric + std::fmt::LowerExp + std::str::FromStr>(
    text: &mut String,
    value: T,
    bounds: Bounds<T>,
    estimate: impl FnOnce() -> f64,
) {
    let Bounds { min, max, step } = bounds;
    if !(min <= value && value <= max && T::ZERO < step) {
        return;
    }
    let (Some(shortest), Some(min_at), Some(step_at)) = (Decimal::of(value), Decimal::of(min), Decimal::of(step)) else { return };
    // When value is below max, their rounding intervals do not overlap. At max, compare to
    // the decimal hint rather than the binary float itself.
    let limit = (value == max).then_some(shortest);
    let fits = |point: Decimal| limit.is_none_or(|max| point.at_most(max));
    if Decimal::from_mantissa(text, 0).is_some_and(|point| point.on_grid(min_at, step_at) && fits(point))
        && text.parse::<T>().ok() == Some(value)
    {
        return;
    }
    if let Some(near) = shortest.near_step(min_at, step_at, estimate) {
        if let Some(point) = min_at.step_candidates(step_at, near, [0, -1, 1]).find(|&p| fits(p) && p.reads_as(value)) {
            point.write_fixed(text);
        }
    }
}

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
        Self::from_mantissa(mantissa, exponent.parse().ok()?)
    }

    fn from_mantissa(mantissa: &str, exponent: i32) -> Option<Self> {
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
        let exponent = exponent.checked_sub(i32::try_from(fraction.len()).ok()?)?;
        Some(Decimal { digits: if negative { -digits } else { digits }, exponent })
    }

    fn step_distance(self, from: Decimal, step: Decimal) -> Option<(i128, i128)> {
        let exponent = self.exponent.min(from.exponent).min(step.exponent);
        Some((self.at(exponent)?.checked_sub(from.at(exponent)?)?, step.at(exponent)?))
    }

    fn on_grid(self, from: Decimal, step: Decimal) -> bool {
        self.step_distance(from, step).is_some_and(|(apart, step)| apart >= 0 && apart % step == 0)
    }

    fn near_step(self, from: Decimal, step: Decimal, estimate: impl FnOnce() -> f64) -> Option<i128> {
        // Use exact decimal arithmetic when it fits. Otherwise the estimate's error grows with
        // the number of steps, so this path mostly refuses: no nearby step reads as the value.
        if let Some((apart, step)) = self.step_distance(from, step) {
            let (whole, left) = (apart.div_euclid(step), apart.rem_euclid(step));
            Some(if left >= step - left { whole + 1 } else { whole })
        } else {
            let near = estimate().round();
            (near.abs() < 1e30).then_some(near as i128)
        }
    }

    /// The grid points around `near`, as exact decimals where the digits fit an `i128`.
    fn step_candidates(self, step: Decimal, near: i128, offsets: [i128; 3]) -> impl Iterator<Item = Decimal> {
        let exponent = self.exponent.min(step.exponent);
        offsets.into_iter().filter_map(move |offset| {
            let k = near.checked_add(offset)?;
            if k < 0 {
                return None;
            }
            let digits = self.at(exponent)?.checked_add(step.at(exponent)?.checked_mul(k)?)?;
            Some(Decimal { digits, exponent })
        })
    }

    fn reads_as<T: std::str::FromStr + PartialEq>(self, value: T) -> bool {
        use std::fmt::Write;
        let mut text = Buf { bytes: [0; 64], len: 0 };
        write!(text, "{}e{}", self.digits, self.exponent).is_ok()
            && std::str::from_utf8(&text.bytes[..text.len]).ok().and_then(|t| t.parse().ok()) == Some(value)
    }

    fn at_most(self, other: Decimal) -> bool {
        // If scaling overflows, that coefficient's magnitude is greater than the other's.
        if self.exponent < other.exponent {
            other.at(self.exponent).map_or(other.digits > 0, |right| self.digits <= right)
        } else {
            self.at(other.exponent).map_or(self.digits < 0, |left| left <= other.digits)
        }
    }

    fn write_fixed(self, out: &mut String) {
        use std::fmt::Write;
        out.clear();
        if self.exponent >= 0 {
            write!(out, "{}", self.digits).unwrap();
            out.extend(std::iter::repeat_n('0', self.exponent as usize));
        } else {
            if self.digits < 0 {
                out.push('-');
            }
            let places = self.exponent.unsigned_abs() as usize;
            let width = places + 1;
            write!(out, "{:0width$}", self.digits.unsigned_abs()).unwrap();
            out.insert(out.len() - places, '.');
        }
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
    use crate::form::Entry;

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
        let ratio = Bounds::<f64>::any_step(0.0, 1.0);
        assert!(ratio.holds(0.0) && ratio.holds(0.375) && ratio.holds(1.0 / 3.0) && ratio.holds(1.0));
        assert!(!ratio.holds(-0.000_001) && !ratio.holds(1.000_000_1));
        assert!(!ratio.holds(f64::NAN) && !ratio.holds(f64::INFINITY) && !ratio.holds(f64::NEG_INFINITY));
        let open = Bounds::<f64>::any_step(f64::MIN, f64::MAX);
        assert!(open.holds(f64::MAX) && open.holds(f64::MIN) && !open.holds(f64::INFINITY) && !open.holds(f64::NEG_INFINITY));
        assert!(ratio.is_any_step());
        assert!(!Bounds::new(0.0, 1.0).step(0.25).is_any_step());
    }

    #[test]
    fn an_exclusive_end_refuses_the_end_and_holds_the_next_number() {
        let above = Bounds::<f64>::any_step(0.0, 10.0).exclusive_min();
        assert!(!above.holds(0.0) && !above.holds(-0.0));
        // The smallest f64 above zero reads from a form and holds.
        let least = super::super::Entry::<f64>::typed("5e-324");
        assert_eq!(least.value(), Some(5e-324));
        assert_eq!(above.read(&least), Some(5e-324));
        assert!(above.holds(10.0));
        let one = Bounds::<f64>::any_step(1.0, 2.0).exclusive_min().exclusive_max();
        assert!(!one.holds(1.0) && one.holds(1.0f64.next_up()) && one.holds(2.0f64.next_down()) && !one.holds(2.0));
        assert!(!one.holds(f64::NAN) && !one.holds(f64::INFINITY));
        let below = Bounds::<f32>::any_step(0.0, 1.0).exclusive_max();
        assert!(below.holds(0.0) && below.holds(1.0f32.next_down()) && !below.holds(1.0));
        // One remaining representable number is a valid range, including either signed zero.
        const ZERO: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(-5e-324, 0.0);
        assert!(ZERO.holds(-0.0) && ZERO.holds(0.0));
        const ONLY: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(0.0, 5e-324).exclusive_min();
        assert!(!ONLY.holds(0.0) && ONLY.holds(5e-324));
    }

    #[test]
    fn a_number_that_reads_as_the_excluded_end_is_refused() {
        // 1e-50 is above 0, and the browser's double says so, but it reads as 0 in an f32.
        let above = Bounds::<f32>::any_step(0.0, 1.0).exclusive_min();
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
        Bounds::<f64>::any_step(0.0, 1.0).render_attrs(&mut out);
        assert_eq!(out, r#" min="0" max="1" step="any""#);
    }

    #[test]
    fn exclusive_f64_ends_keep_the_inclusive_hints() {
        use super::super::Entry;

        let bounds = Bounds::<f64>::any_step(-0.001, 0.001).exclusive_min().exclusive_max();
        let mut out = String::new();
        bounds.render_attrs(&mut out);
        assert_eq!(out, r#" min="-0.001" max="0.001" step="any""#);
        assert_eq!(bounds.read(&Entry::typed("-0.001")), None);
        assert_eq!(bounds.read(&Entry::typed("0.001")), None);
        assert_eq!(bounds.read(&Entry::typed("-0.0009999999999999998")), Some((-0.001f64).next_up()));
        assert_eq!(bounds.read(&Entry::typed("0.0009999999999999998")), Some(0.001f64.next_down()));
    }

    #[test]
    fn a_precise_exclusive_end_keeps_its_exact_hint() {
        // docs/design.md#choice-exclusive-ends: Chromium and WebKit can block
        // the fixed spelling of the next float, but we keep the unshifted native hint.
        let min = 0.0010000000000000002_f64;
        let bounds = Bounds::<f64>::any_step(min, 1.0).exclusive_min();
        let mut out = String::new();
        bounds.render_attrs(&mut out);
        assert_eq!(out, r#" min="1.0000000000000002e-3" max="1" step="any""#);
        assert_eq!(bounds.read(&Entry::typed("0.0010000000000000005")), Some(min.next_up()));
    }

    #[test]
    fn exclusive_f32_ends_keep_the_inclusive_hints() {
        use super::super::Entry;

        let bounds = Bounds::<f32>::any_step(-1.0, 1.0).exclusive_min().exclusive_max();
        let mut out = String::new();
        bounds.render_attrs(&mut out);
        assert_eq!(out, r#" min="-1" max="1" step="any""#);
        assert_eq!(bounds.read(&Entry::typed("-1")), None);
        assert_eq!(bounds.read(&Entry::typed("1")), None);
        assert_eq!(bounds.read(&Entry::typed("-0.9999999701976776123046874")), Some((-1.0f32).next_up()));
        assert_eq!(bounds.read(&Entry::typed("0.9999999701976776123046874")), Some(1.0f32.next_down()));
    }

    #[test]
    fn inclusive_any_step_ends_can_span_the_whole_finite_type() {
        const ALL: Bounds<f32, AnyStep> = Bounds::<f32>::any_step(f32::MIN, f32::MAX);
        let mut out = String::new();
        ALL.render_attrs(&mut out);
        assert_eq!(out, r#" min="-3.4028235e38" max="3.4028235e38" step="any""#);
        assert!(ALL.holds(f32::MIN) && ALL.holds(f32::MAX));
    }

    #[test]
    fn tiny_and_extreme_exclusive_ends_render_in_exponent_form() {
        const TINY: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(-1e-20, 1e-20).exclusive_min().exclusive_max();
        const WIDE: Bounds<f64, AnyStep> = Bounds::<f64>::any_step(f64::MIN, f64::MAX).exclusive_min().exclusive_max();
        let mut out = String::new();
        TINY.render_attrs(&mut out);
        assert_eq!(out, r#" min="-1e-20" max="1e-20" step="any""#);
        out.clear();
        WIDE.render_attrs(&mut out);
        assert_eq!(out, r#" min="-1.7976931348623157e308" max="1.7976931348623157e308" step="any""#);
    }

    #[test]
    fn a_native_value_escapes_typed_text_and_omits_unset_values() {
        let bounds = Bounds::<f64>::any_step(0.0, 100.0).exclusive_min();
        let mut out = String::new();
        bounds.input_value(&Entry::default()).write_attr(" value", &mut out);
        assert!(out.is_empty());
        bounds.input_value(&Entry::typed("0.00000000000000000001")).write_attr(" value", &mut out);
        bounds.input_value(&Entry::typed("\"<&")).write_attr(" value", &mut out);
        assert_eq!(out, r#" value="0.00000000000000000001" value="&quot;&lt;&amp;""#);
    }

    #[test]
    fn a_stepped_prefill_keeps_the_value_the_handler_accepts() {
        for (min, step, value, expected) in [(0.5, 1.0, 1.5, "1.5"), (0.25, 0.5, 0.75, "0.75"), (-0.75, 1.0, -0.75, "-0.75")] {
            let bounds = Bounds::new(min, 10.0f64).step(step);
            let mut attr = String::new();
            bounds.input_value(&Entry::from(value)).write_attr(" value", &mut attr);
            let drawn = attr.strip_prefix(" value=\"").unwrap().strip_suffix('"').unwrap();
            assert_eq!(drawn, expected);
            assert_eq!(bounds.read(&Entry::typed(drawn)), Some(value));
        }
        // This f32's shortest spelling is 1234567.3, which is off the browser's grid.
        let bounds = Bounds::new(0.25f32, 2e6).step(1.0);
        let value = Entry::typed("1234567.25").value().unwrap();
        let mut attr = String::new();
        bounds.input_value(&Entry::from(value)).write_attr(" value", &mut attr);
        assert_eq!(attr, r#" value="1234567.25""#);
        assert_eq!(bounds.read(&Entry::typed("1234567.25")), Some(value));
    }

    #[test]
    fn a_rounded_float_prefill_uses_a_decimal_on_the_step_grid() {
        fn assert_prefill<T: Numeric>(bounds: Bounds<T>, submitted: &str, expected: &str) {
            let entry = Entry::typed(submitted);
            let value = entry.value().unwrap();
            assert!(bounds.holds(value));
            assert_eq!(bounds.read(&entry), Some(value));
            let mut out = String::new();
            bounds.input_value(&Entry::from(value)).write_attr(" value", &mut out);
            assert_eq!(out, format!(r#" value="{expected}""#));
            let rendered = out.strip_prefix(" value=\"").unwrap().strip_suffix('"').unwrap();
            assert_eq!(bounds.read(&Entry::typed(rendered)), Some(value));
        }
        for (min, max, step, submitted, expected) in [
            (0.25f32, 2e6, 0.1, "1000000.45", "1000000.45"),
            (0.0, 1e6, 0.05, "335545.10", "335545.10"),
            (0.35, 2e6, 1.0, "1234567.35", "1234567.35"),
            (-2e6, 0.0, 0.05, "-1000000.05", "-1000000.05"),
            // The old spelling is already on-grid, even though this float has other witnesses.
            (0.0, 1e6, 0.01, "335545.10", "335545.09"),
        ] {
            assert_prefill(Bounds::new(min, max).step(step), submitted, expected);
        }
        assert_prefill(Bounds::new(0.25f64, 1e15).step(0.1), "500000000000000.45", "500000000000000.45");

        // The binary value is 1234567.625, but max is rendered as 1234567.6.
        let bounds = Bounds::new(0.0f32, "1234567.625".parse().unwrap()).step(0.025);
        let mut attrs = String::new();
        bounds.render_attrs(&mut attrs);
        assert_eq!(attrs, r#" min="0" max="1234567.6" step="0.025""#);
        assert_prefill(bounds, "1234567.625", "1234567.600");
    }

    #[test]
    fn a_stepped_prefill_does_not_snap_an_invalid_value_to_the_grid() {
        let bounds = Bounds::new(0.25f32, 2e6).step(0.1);
        for (bounds, submitted, expected) in [
            (bounds, "1000000.50", "1000000.50"),
            (Bounds::new(0.25, 999999.0).step(0.1), "1000000.45", "1000000.44"),
            (Bounds::new(0.25, 2e6).step(0.0), "1000000.45", "1000000.44"),
            (Bounds::new(0.25, 2e6).step(-0.1), "1000000.45", "1000000.44"),
            (Bounds::new(0.25, 2e6).step(f32::NAN), "1000000.45", "1000000.44"),
            (Bounds::new(0.25, 2e6).step(f32::INFINITY), "1000000.45", "1000000.44"),
        ] {
            let value = Entry::typed(submitted).value().unwrap();
            assert!(!bounds.holds(value));
            let mut out = String::new();
            bounds.input_value(&Entry::from(value)).write_attr(" value", &mut out);
            assert_eq!(out, format!(r#" value="{expected}""#));
        }
        let mut out = String::new();
        bounds.input_value(&Entry::typed("1000000.500")).write_attr(" value", &mut out);
        assert_eq!(out, r#" value="1000000.500""#);

        // Its only on-grid spelling is above the decimal max. Do not substitute it.
        let value = Entry::typed("1000000.45").value().unwrap();
        let bounds = Bounds::new(0.25f32, value).step(0.1);
        assert!(bounds.holds(value));
        out.clear();
        bounds.input_value(&Entry::from(value)).write_attr(" value", &mut out);
        bounds.render_attrs(&mut out);
        assert_eq!(out, r#" value="1000000.44" min="0.25" max="1000000.44" step="0.1""#);
    }

    #[test]
    fn a_native_prefill_uses_the_bounds_spacing() {
        let mut out = String::new();
        Bounds::<f64>::any_step(0.0, 100.0).input_value(&Entry::from(1e-20)).write_attr(" value", &mut out);
        Bounds::<f32>::any_step(0.0, 100.0).input_value(&Entry::from(0.5)).write_attr(" value", &mut out);
        Bounds::new(0.0, 100.0).step(0.01).input_value(&Entry::from(12.5)).write_attr(" value", &mut out);
        Bounds::new(-2i32, 10).step(3).input_value(&Entry::from(4)).write_attr(" value", &mut out);
        assert_eq!(out, r#" value="1e-20" value="0.5" value="12.50" value="4""#);
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
        // Each reads back as the same number.
        for v in [1e-20, 1.2345678901234568e-5, 5e-324, f64::MAX, -1e-300, 1.5e25] {
            assert_eq!(written(&|o| v.write_value(o)).parse::<f64>(), Ok(v));
        }
        // Entries on their own keep their existing output, with or without original text.
        let mut out = String::new();
        super::super::Entry::from(1e-20).write_attr(" value", &mut out);
        super::super::Entry::<f64>::typed("0.00000000000000000001").write_attr(" value", &mut out);
        assert_eq!(out, r#" value="0.00000000000000000001" value="0.00000000000000000001""#);
    }

    #[test]
    fn a_value_is_shown_with_its_steps_decimals() {
        assert_eq!(12.5f64.shown(0.01), "12.50");
        assert_eq!(0.5f64.shown(0.1), "0.5");
        assert_eq!(3.0f64.shown(1.0), "3");
        assert_eq!(7u32.shown(1), "7");
    }
}
