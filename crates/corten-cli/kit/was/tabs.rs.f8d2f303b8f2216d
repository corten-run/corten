// corten ui {{version}}: tabs
//! The look of corten-ui's `TabGroup` written inside it: the tab list as a segmented control,
//! the selected tab raised. Its behavior and markup are corten-ui's (docs/guide/ui.md); this
//! styles them by role and state, so the app lists `corten_ui::COMPONENTS` too.
//!
//! ```rust,ignore
//! <Tabs><TabGroup id="book" label={t.market()} tabs={&tabs} selected={0} /></Tabs>
//! ```
//!
//! Links that each load a view of the page (a filter, a period) are navigation, not tabs over
//! panels: the same look is `TabLinks` on their `<nav>`, the current one `aria-current="page"`,
//! as a screen reader announces it, and they work without the script:
//!
//! ```rust,ignore
//! <nav class={TabLinks {}} aria-label={t.filter()}>
//!     <a href={url::Accounts { filter: None }} aria-current={current(None)}>{t.all()}</a>
//!     <a href={url::Accounts { filter: Some(Filter::Credits) }} aria-current={current(Some(Filter::Credits))}>{t.credits()}</a>
//! </nav>
//! ```
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Tabs() -> impl Render {
///     html! { <div class={(Tabs, Vertical)}></div> }
/// }
/// ```
#[component(css)]
pub fn Tabs<C: Render>(children: C) -> impl Render {
    html! { <div class={Tabs}>{children}</div> }
}

/// The tabs' segmented look on a `<nav>` of links, each a view the server renders, the current
/// one `aria-current="page"`.
#[component(css = Tabs)]
pub fn TabLinks() -> impl ClassList {
    Links
}
