// corten ui {{version}}: visually_hidden
//! Text a screen reader reads and the page does not draw, as the class of the element you write:
//! an icon control's name, a legend a layout does not need to show, a busy region's words.
//!
//! ```rust,ignore
//! <DropdownMenu trigger={MenuTrigger::Icon}>
//!     <MenuButton
//!         id={RowMenuId(&row.reference)}
//!         label={html! {
//!             <span aria-hidden="true">"⋮"</span>
//!             <span class={VisuallyHidden {}}>"More actions for "{&row.reference}</span>
//!         }}
//!     >
//!         ..
//!     </MenuButton>
//! </DropdownMenu>
//! ```
//!
//! Text no one should read is `hidden`, and a mark that only decorates is `aria-hidden="true"`.
use corten::prelude::*;

/// A part without a rule in `visually_hidden.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn VisuallyHidden() -> impl ClassList {
///     (VisuallyHidden, Focusable)
/// }
/// ```
#[component(css)]
pub fn VisuallyHidden() -> impl ClassList {
    VisuallyHidden
}
