// corten ui {{version}}: stepper
//! The look of corten-ui's `NumberField` written inside it: its input and its two buttons in a
//! row, each drawn as the kit's fields and outline buttons are, at `--control-height`. A
//! `StepperUnit` before the field (a unit: "oz", "%") sits between the decrease button and the
//! input. The app lists `corten_ui::COMPONENTS` too.
//!
//! ```rust,ignore
//! <Field id={WeightId} label={t.weight()} hint="" error="">
//!     <Stepper><span class={StepperUnit {}}>"oz"</span><NumberField field={&weight} /></Stepper>
//! </Field>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Stepper() -> impl Render {
///     html! { <span class={(Stepper, Wide)}></span> }
/// }
/// ```
#[component(css)]
pub fn Stepper<C: Render>(children: C) -> impl Render {
    html! { <span class={Stepper}>{children}</span> }
}

/// A unit beside the number, written before the `NumberField`.
#[component(css = Stepper)]
pub fn StepperUnit() -> impl ClassList {
    Unit
}
