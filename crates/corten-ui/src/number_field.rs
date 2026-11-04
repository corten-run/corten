use corten::{
    form::Numeric,
    prelude::*,
    view::{Attrs, Id},
};

/// A number field's input and buttons, for a field the user types (`qty: Entry<u32>`). Start from
/// [`Number::new`] with the field's [`Bounds`], the constant its handler checks
/// (`QTY.read(&input.qty)`), and set what differs: a new form's number (`1.into()`), or, drawn
/// again after a refusal, what was sent (`input.qty.clone()`), shown as it was typed.
///
/// ```ignore
/// const QTY: Bounds<u32> = Bounds::new(1, 99);
/// let qty = Number { value: 1.into(), ..Number::new(QtyId, f.qty, QTY, t.fewer(), t.more()) };
/// html! { <NumberField field={&qty} /> }
/// ```
pub struct Number<'a, I, T> {
    /// The input's `#[derive(Id)]` id, for the app's `<label for>` (or a form's `e.id(f.qty)`).
    pub id: I,
    /// The form field's name: `Input::FIELDS.qty`.
    pub name: FieldName,
    /// The input's value: a number, the text a refused form sent, or nothing (`Entry::default()`).
    pub value: Entry<T>,
    /// Its `min`, `max` and `step`: the amount a button or arrow key adds, which also sets the
    /// decimals shown (`0.1` shows `0.5` as `0.5`, `0.25` shows it as `0.50`). Page Up and Page
    /// Down add ten steps.
    pub bounds: Bounds<T>,
    pub required: bool,
    pub disabled: bool,
    pub decrease: Step<'a>,
    pub increase: Step<'a>,
    /// More attributes for the input, such as `errors.within(form).aria(field)` or a placeholder.
    pub attrs: &'a dyn Attrs,
}

/// One of the two buttons.
pub struct Step<'a> {
    /// The button's accessible name, in the page's language: "Fewer".
    pub label: &'a str,
    /// What it shows: text or an icon.
    pub content: &'a dyn Render,
}

const MINUS: &str = "\u{2212}";
const PLUS: &str = "+";
static NO_ATTRS: [(&str, bool); 0] = [];

impl<'a, I: Id, T: Numeric> Number<'a, I, T> {
    /// A field with no value and buttons showing − and +, for a number the user types
    /// (`qty: Entry<u32>`) within `bounds` of its type. Another field's name does not compile, a
    /// typed one (`qty: u32`) included, since a number that does not read would be the error page
    /// rather than the form with its message:
    ///
    /// ```compile_fail,E0308
    /// use corten::prelude::*;
    /// use corten_ui::Number;
    ///
    /// #[derive(serde::Deserialize, Fields)]
    /// struct Order { qty: u32 }
    /// #[derive(Id)]
    /// struct QtyId;
    ///
    /// let _ = Number::new(QtyId, Order::FIELDS.qty, Bounds::new(1, 9), "Fewer", "More");
    /// ```
    ///
    /// ```compile_fail,E0308
    /// use corten::prelude::*;
    /// use corten_ui::Number;
    ///
    /// #[derive(serde::Deserialize, Fields)]
    /// struct Order { qty: Entry<u32>, note: String }
    /// #[derive(Id)]
    /// struct NoteId;
    ///
    /// let _ = Number::new(NoteId, Order::FIELDS.note, Bounds::new(1, 9), "Fewer", "More");
    /// ```
    ///
    /// and nor do bounds of another type than the field's, which the handler could not check
    /// it with:
    ///
    /// ```compile_fail,E0308
    /// use corten::prelude::*;
    /// use corten_ui::Number;
    ///
    /// #[derive(serde::Deserialize, Fields)]
    /// struct Order { qty: Entry<u32> }
    /// #[derive(Id)]
    /// struct QtyId;
    ///
    /// const WEIGHT: Bounds<f64> = Bounds::new(0.1, 16.0);
    /// let _ = Number::new(QtyId, Order::FIELDS.qty, WEIGHT, "Fewer", "More");
    /// ```
    ///
    /// Its id is a `#[derive(Id)]` type, so the label's `for` and the input cannot drift; text
    /// does not compile:
    ///
    /// ```compile_fail,E0277
    /// use corten::prelude::*;
    /// use corten_ui::Number;
    ///
    /// #[derive(serde::Deserialize, Fields)]
    /// struct Order { qty: Entry<u32> }
    ///
    /// let _ = Number::new("qty", Order::FIELDS.qty, Bounds::new(1, 9), "Fewer", "More");
    /// ```
    pub fn new(id: I, name: FieldName<Entry<T>>, bounds: Bounds<T>, decrease: &'a str, increase: &'a str) -> Self {
        Number {
            id,
            name: name.untyped(),
            value: Entry::default(),
            bounds,
            required: false,
            disabled: false,
            decrease: Step { label: decrease, content: &MINUS },
            increase: Step { label: increase, content: &PLUS },
            attrs: &NO_ATTRS,
        }
    }
}

/// A number input between a decrease and an increase button, for a count or a measure: a
/// quantity, seats, nights, a weight.
///
/// Not for money. A `type="number"` input takes only the browser's own decimal syntax, so
/// `$1,299.99` or a French `1 299,99` never reaches the server, and the field reads a binary
/// number. A price is a text input with `inputmode="decimal"`, which shows a refused
/// entry back as typed, read by `t.parse_money(&input.price, USD)` into `Minor` units in the
/// page's locale.
///
/// The input is a native `<input type="number">`, so without the script it still steps with the
/// arrow keys, and the browser checks `min`, `max`, `step` and `required` when the form is
/// sent. The script (`number_field.js`) adds the buttons (press and hold repeats), Page Up and
/// Page Down, keeps the step's decimals, disables a button at its bound, and sends `input` and
/// `change` events like typing does.
///
/// Parts: a `div` around `input` and `button[aria-controls]` twice, the first decreasing;
/// `button:disabled` at a bound. Hide the input's own spin buttons in the design system's CSS
/// (`appearance: textfield` and `::-webkit-inner-spin-button`).
///
/// ```
/// use corten::prelude::*;
/// use corten_ui::{Number, NumberField};
///
/// #[derive(Fields)]
/// struct Order { qty: Entry<u32> }
///
/// #[derive(Id)]
/// struct QtyId; // ui-qty: ids in this crate's examples start with its prefix
///
/// let qty = Number { value: 1.into(), ..Number::new(QtyId, Order::FIELDS.qty, Bounds::new(1, 99), "Fewer", "More") };
/// let html = NumberField { field: &qty }.to_html();
/// assert!(html.starts_with(r#"<div data-scope="ui-number-field" data-on="connect:ui.number_field.connect(@decrease,@input,@increase,$s)"><button data-ref="decrease" type="button" aria-controls="ui-qty" aria-label="Fewer" tabindex="-1" disabled"#));
/// assert!(html.contains(r#"<input data-ref="input" type="number" inputmode="decimal" id="ui-qty" name="qty" value="1" min="1" max="99" step="1""#));
/// ```
#[component(js)]
pub fn NumberField<'a, I: Id, T: Numeric>(field: &'a Number<'a, I, T>) -> impl Render {
    let f = field;
    let (input, decrease, increase) = refs();
    let number = f.value.value();
    let at_min = number.is_some_and(|v| v <= f.bounds.min());
    let at_max = number.is_some_and(|v| v >= f.bounds.max());
    // What was sent, as typed; a number made in code with its step's decimals.
    let shown = match f.value.text() {
        Some(text) => Some(std::borrow::Cow::Borrowed(text)),
        None => number.map(|v| std::borrow::Cow::Owned(v.shown(f.bounds.step_size()))),
    };
    html! {
        <div on:connect={js::connect(decrease, input, increase, signal)}>
            <button
                ref={decrease}
                type="button"
                aria-controls={&f.id}
                aria-label={f.decrease.label}
                tabindex="-1"
                disabled={f.disabled || at_min}
                on:pointerdown={js::press(event, target, input, -1)}
                on:click={js::click(event, target, input, -1)}
            >
                {f.decrease.content}
            </button>
            <input
                ref={input}
                type="number"
                inputmode="decimal"
                id={&f.id}
                name={f.name}
                value={shown}
                {..f.bounds}
                required={f.required}
                disabled={f.disabled}
                on:keydown={js::key(event, input)}
                on:input={js::sync(decrease, input, increase)}
                on:change={js::sync(decrease, input, increase)}
                {..f.attrs}
            >
            <button
                ref={increase}
                type="button"
                aria-controls={&f.id}
                aria-label={f.increase.label}
                tabindex="-1"
                disabled={f.disabled || at_max}
                on:pointerdown={js::press(event, target, input, 1)}
                on:click={js::click(event, target, input, 1)}
            >
                {f.increase.content}
            </button>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_keep_the_decimals_of_the_step() {
        #[derive(Fields)]
        #[allow(dead_code)]
        struct Form {
            p: Entry<f64>,
        }
        #[derive(Id)]
        struct PriceId;
        let cents = Bounds::new(0.0, 100.0).step(0.01);
        let price = Number { value: 12.5.into(), ..Number::new(PriceId, Form::FIELDS.p, cents, "Less", "More") };
        assert!(NumberField { field: &price }.to_html().contains(r#"value="12.50""#));
        // Drawn again after a refusal: as typed, and no bound reached.
        let sent = Number { value: Entry::typed("12.5x"), ..Number::new(PriceId, Form::FIELDS.p, cents, "Less", "More") };
        let html = NumberField { field: &sent }.to_html();
        assert!(html.contains(r#"value="12.5x""#) && !html.contains(" disabled"), "{html}");
    }
}
