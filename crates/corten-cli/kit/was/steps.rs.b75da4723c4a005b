// corten ui {{version}}: steps
//! The steps of a workflow, in order: the classes of the `<ol>` you write inside a
//! `<nav aria-label>`. Each step is a link to the step's page (a GET, so it can be linked to and
//! works without a script), or a `<span>` for one not reachable yet, and the current one is
//! `aria-current="step"`. The numbers are counted, not written, and the steps before the current
//! one are drawn done: a check mark in place of the number, which a screen reader does not read.
//!
//! ```rust,ignore
//! <nav aria-label={t.steps()}>
//!     <ol class={Steps {}}>
//!         <li><a href={url::Load}>{t.load()}<span class={StepStatus {}}>{t.done()}</span></a></li>
//!         <li><a href={url::Pick} aria-current="step">{t.pick()}</a></li>
//!         <li><span>{t.ship()}</span></li>
//!     </ol>
//! </nav>
//! ```
//!
//! Done is the steps' position alone: every step before the current one, as a linear workflow has
//! it. A screen reader hears it only from words in the step, so write them in a `StepStatus`,
//! seen by no one else and read after the step's name (" (done)", " (not started)"). A step the
//! user skipped, before the current one but not done, is drawn done all the same.
use corten::prelude::*;

/// A part without a rule does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn Steps() -> impl ClassList {
///     (Steps, Vertical)
/// }
/// ```
#[component(css)]
pub fn Steps() -> impl ClassList {
    Steps
}

/// Words a screen reader reads after the step's name and the page does not show: " (done)".
#[component(css = Steps)]
pub fn StepStatus() -> impl ClassList {
    Status
}
