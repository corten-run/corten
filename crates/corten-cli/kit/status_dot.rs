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
//! `LiveDot` is the dot of a live view's badge: it pulses while the `<corten-live>` around it is
//! live, so a glance tells a live view from a frozen one, and is still while the stream connects,
//! reconnects or has closed or ended, before the runtime runs and without JavaScript. Outside a
//! `<corten-live>` it is still. It pulses only for a user who has not asked for less motion, and
//! the motion is never the only sign: the words beside it must follow the stream too, as the
//! element's `status` attribute does (the live-data guide shows them by `corten-live[status=..]`
//! or writes them from a `corten-status` handler). Inside two nested streams it pulses while either
//! is live.
//!
//! ```rust,ignore
//! <corten-live src={url::LotFeed { id }} class={LotFeed}>
//!     <span class={Badge { tone: BadgeTone::Info, emphasis: BadgeEmphasis::Soft }}>
//!         <LiveDot tone={StatusTone::Info} />
//!         <span class={WhenLive}>"Live"</span>
//!         <span class={WhenNot}>"Reconnecting"</span>
//!     </span>
//!     ..
//! </corten-live>
//! ```
//!
//! It is a component of its own rather than a variant of `StatusDot`: where it is placed decides
//! what it draws, and every still dot stays `StatusDot { tone }`.
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

/// A status dot that pulses while the `<corten-live>` around it is live.
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
