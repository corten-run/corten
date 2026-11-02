// corten ui {{version}}: steps
//! The steps of a workflow, in order: the classes of the `<ol>` you write inside a
//! `<nav aria-label>`, and a `Step` for each. A step is a link to its page (a GET, so it can be
//! linked to and works without a script), or text for one with no page to go to. Its state is
//! written, not worked out from where it is: a done step is drawn with a check mark in place of its
//! number and says the words you give it after its name to a screen reader ("(done)"), which the
//! page does not show; the current one is `aria-current="step"`; any other is numbered, with its
//! words ("(not started)", "(skipped)"). So a skipped step is not drawn done, and a finished
//! workflow is every step done.
//!
//! ```rust,ignore
//! <nav aria-label={t.steps()}>
//!     <ol class={Steps {}}>
//!         <Step label={t.load()} link={Some(&url::Load)} state={StepState::Done(t.done())} />
//!         <Step label={t.pick()} link={Some(&url::Pick)} state={StepState::Current} />
//!         <Step label={t.ship()} link={None} state={StepState::Todo(t.not_started())} />
//!     </ol>
//! </nav>
//! ```
use corten::{Href, prelude::*};

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

/// Where a step is in the workflow: what draws its mark and what a screen reader hears.
pub enum StepState<'a> {
    /// Finished: a check mark in place of its number, and these words after its name, read by a
    /// screen reader and not shown (" (done)").
    Done(&'a str),
    /// The step the user is on: `aria-current="step"`, drawn filled.
    Current,
    /// Not finished: its number, and these words after its name, read and not shown
    /// (" (not started)", " (skipped)").
    Todo(&'a str),
}

/// One step: its `<li>`, with a link to the step's page or, with no `link`, its name as text.
#[component(css = Steps)]
pub fn Step<'a>(label: &'a str, link: Option<&'a dyn Href>, state: StepState<'a>) -> impl Render {
    let (done, current, status) = match state {
        StepState::Done(words) => (Some(Done), None, *words),
        StepState::Current => (None, Some("step"), ""),
        StepState::Todo(words) => (None, None, *words),
    };
    html! {
        <li class={done}>
            if let Some(link) = link {
                <a href={link} aria-current={current}>
                    {label}
                    if !status.is_empty() { <span class={Status}>{status}</span> }
                </a>
            } else {
                <span aria-current={current}>
                    {label}
                    if !status.is_empty() { <span class={Status}>{status}</span> }
                </span>
            }
        </li>
    }
}
