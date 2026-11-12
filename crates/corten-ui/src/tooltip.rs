use corten::{prelude::*, view::Id};

/// A short text shown beside a button or link while the pointer rests on it or it has keyboard
/// focus: what an icon-only control is, what a status word stands for, a keyboard shortcut. The
/// app writes the platform's attributes on its own control, naming the tooltip by its
/// `#[derive(Id)]` id: `interestfor`, which shows it, and `aria-describedby` (the text adds to the
/// control's name) or, on an icon-only control, `aria-labelledby` (the text is its name). The
/// tooltip is a `popover="hint"`: the browser puts it in the top layer, anchors it to the control
/// that showed it (place it with `position-area`), and closes it on Escape, without moving focus.
///
/// Where the browser has `interestfor` (Chromium), the browser shows and hides it, with or
/// without a script, and the script does nothing. Elsewhere (Firefox and WebKit in November 2026)
/// the script does the same: shown once the pointer has rested on the control half a second, and
/// at once on keyboard focus; kept while the pointer moves onto it; hidden a quarter second after
/// the pointer leaves both, when focus leaves, or on Escape, after which the pointer moving onto the
/// control (or an element in it) again, or focus returning, shows it as before, as Chromium does;
/// Escape also stops one about to show. Only an `<a>`, `<button>` or `<area>` shows one, as with
/// `interestfor` itself, so text that shows one is a `<button type="button">` (the kit's `TipText`
/// look draws it as the text around it). In Firefox and WebKit, without a script, it is not shown,
/// though a screen reader still reads it through `aria-describedby` or `aria-labelledby`; a
/// sighted user sees only the control. So an icon-only control's icon is one
/// whose meaning shows (a close mark, an arrow out), and text a user must read to act (a field's
/// error, a price's reason) is on the page or in a popover a click opens (`popovertarget`), which a
/// phone opens too. It adds no `title`: where the browser shows the tooltip, a title would show
/// a second one.
///
/// Parts: the `span[popover=hint][role=tooltip]`, which has the classes `class` gives it (`()` for
/// none: a look of the app's, the kit's `Tip`).
///
/// ```
/// use corten::prelude::*;
/// use corten_ui::Tooltip;
///
/// #[derive(Id)]
/// struct SaveTipId; // ui-save-tip: ids in this crate's examples start with its prefix
///
/// let html = html! {
///     <button type="button" interestfor={SaveTipId} aria-describedby={SaveTipId}>"Save"</button>
///     <Tooltip id={SaveTipId} class={()}>"Saves the draft; Ctrl+S"</Tooltip>
/// }
/// .to_html();
/// assert!(html.contains(r#"<button type="button" interestfor="ui-save-tip" aria-describedby="ui-save-tip">Save</button>"#), "{html}");
/// assert!(html.contains(r#"<span id="ui-save-tip" popover="hint" role="tooltip" data-on='connect:ui.tooltip.connect($t,$s)'>Saves the draft; Ctrl+S</span>"#), "{html}");
/// ```
///
/// Its id is a `#[derive(Id)]` type, the one the control names, so text does not compile:
///
/// ```compile_fail,E0277
/// use corten::prelude::*;
/// use corten_ui::Tooltip;
///
/// let html = html! { <Tooltip id="save-tip" class={()}>"Saves the draft"</Tooltip> };
/// ```
#[component(js)]
pub fn Tooltip<I: Id, L: ClassList, C: Render>(id: I, class: L, children: C) -> impl Render {
    html! {
        <span id={id} class={class} popover="hint" role="tooltip" on:connect={js::connect(target, signal)}>{children}</span>
    }
}
