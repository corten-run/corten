// corten ui {{version}}: status_dot
//! A dot in a status's color, before the words that name it:
//!
//! ```rust,ignore
//! <span class={Badge { tone: BadgeTone::Success, emphasis: BadgeEmphasis::Soft }}>
//!     <StatusDot tone={StatusTone::Success} />
//!     "Open"
//! </span>
//! ```
//!
//! The dot is drawn, not read (`aria-hidden`): color alone tells a status neither to everyone who
//! sees it nor to a screen reader, so the status is always in visible text beside it, never in a
//! `title` alone.
//!
//! `LiveDot` is the dot of a live view's badge: it pulses while the stream it reports is live, so
//! a glance tells a live view from a frozen one. Put the badge inside the `<corten-live>`, and the
//! dot is still whenever the stream is not live (connecting, reconnecting, closed or ended); outside
//! one, it always pulses, so the page draws a `StatusDot` once it knows the view is not live. It
//! pulses only for a user who has not asked for less motion, and never under forced colors; the
//! words beside it still name the state:
//!
//! ```rust,ignore
//! <corten-live src={url::LotFeed { id }}>
//!     <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Soft }}>
//!         <LiveDot tone={StatusTone::Info} />
//!         "Live"
//!     </span>
//!     ..
//! </corten-live>
//! ```
use corten::prelude::*;

/// The dot's color. Each is a class in `status_dot.css`, so one without a rule does not compile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusTone {
    Neutral,
    Info,
    Success,
    Warning,
    Destructive,
}

/// A tone without a rule in `status_dot.css` does not compile:
///
/// ```compile_fail
/// use corten::prelude::*;
///
/// #[component(css)]
/// fn StatusDot() -> impl Render {
///     html! { <span class={(Dot, Blinking)}></span> }
/// }
/// ```
#[component(css)]
pub fn StatusDot(tone: StatusTone) -> impl Render {
    let tone = match tone {
        StatusTone::Neutral => Neutral,
        StatusTone::Info => Info,
        StatusTone::Success => Success,
        StatusTone::Warning => Warning,
        StatusTone::Destructive => Destructive,
    };
    html! { <span class={(Dot, tone)} aria-hidden="true"></span> }
}

/// A status dot that pulses while the `<corten-live>` around it is live (always, outside one).
#[component(css = StatusDot)]
pub fn LiveDot(tone: StatusTone) -> impl Render {
    let tone = match tone {
        StatusTone::Neutral => Neutral,
        StatusTone::Info => Info,
        StatusTone::Success => Success,
        StatusTone::Warning => Warning,
        StatusTone::Destructive => Destructive,
    };
    html! { <span class={(Dot, Live, tone)} aria-hidden="true"></span> }
}
