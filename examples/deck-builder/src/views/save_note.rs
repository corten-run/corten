use corten::prelude::*;

/// The save note's id: every save answers with the note, which replaces it.
#[derive(Id)]
pub struct SaveNoteId;

/// What the server said to the last save, with the deck's version after it (and, for a saved one,
/// which of the page's sends was saved). The page's script reads the outcome; the reader reads the
/// note's text.
pub enum Answer {
    /// Nothing yet: the page as loaded.
    None,
    Saved {
        version: u64,
        draft: u64,
    },
    Refused {
        version: u64,
        message: String,
    },
    /// A native key cannot acknowledge a scripted draft. Draw this on the replacement page
    /// without notifying the autosave queue.
    NativeSubmit,
    /// `unsure`: a save the server no longer remembers may have been this one (`Outcome::Stale`).
    Stale {
        version: u64,
        unsure: bool,
    },
}

/// What became of a save, as the builder's script compares it. A renamed variant fails the Rust
/// build, then `tsc` where a script still compares the old name.
#[derive(Clone, Copy, ToJson)]
pub enum SaveOutcome {
    Saved,
    Refused,
    Stale,
}

impl Answer {
    /// The same notice on a whole page and in a patch.
    pub fn words(&self) -> impl Render + '_ {
        html! {
            match self {
                Answer::None => {}
                Answer::Saved { .. } => { "Saved." }
                Answer::Refused { message, .. } => { "Not saved: "{message} }
                Answer::NativeSubmit => {
                    "Not saved: This form already saved before autosave started. Review the saved deck below before making another change."
                }
                Answer::Stale { .. } => { "Not saved: this deck was changed in another tab." }
            }
        }
    }

    /// Only a scripted save has a queue to notify.
    pub fn patch(&self) -> Option<impl Patch + '_> {
        let (outcome, version, draft, unsure) = match *self {
            Answer::Saved { version, draft } => (SaveOutcome::Saved, version, draft, false),
            Answer::Refused { version, .. } => (SaveOutcome::Refused, version, 0, false),
            Answer::Stale { version, unsure } => (SaveOutcome::Stale, version, 0, unsure),
            Answer::None | Answer::NativeSubmit => return None,
        };
        Some(SaveNote { answer: self, outcome, version, draft, unsure })
    }
}

/// A save's answer, told to the builder around the note: what became of it, the
/// deck's version after it, which send was saved, and, when stale, whether a save the server no
/// longer remembers may have been it. It bubbles from the note.
#[corten::script::event]
pub struct DeckAnswered {
    pub outcome: SaveOutcome,
    pub version: u64,
    pub draft: u64,
    pub unsure: bool,
}

/// An autosave patch displays the notice and tells the builder what became of its send.
#[component(js)]
pub fn SaveNote<'a>(answer: &'a Answer, outcome: SaveOutcome, version: u64, draft: u64, unsure: bool) -> impl Patch {
    html! {
        <span id={SaveNoteId} on:connect={js::answered(target, outcome, version, draft, unsure)}>
            {answer.words()}
        </span>
    }
}
