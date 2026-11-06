use corten::prelude::*;

use super::PreviewHelp;

#[corten::script::event]
pub struct DraftEdited {
    pub note: String,
}
#[corten::script::event]
pub struct DraftOpened {}

#[derive(Id)]
struct DraftNoteId<'a>(&'a str);
#[derive(Id)]
struct DraftHintId<'a>(&'a str);

/// Owns transient editing feedback; the parent owns the draft that survives its removal.
#[component(js)]
pub fn DraftNotes(instance: &str) -> impl Render {
    let (field, editing, ready) = refs();
    html! {
        <fieldset on:connect={js::start(field, editing, ready, signal)}>
            <legend>"Draft notes"</legend>
            <label for={DraftNoteId(instance)}>"Notes"</label>
            <textarea
                ref={field}
                id={DraftNoteId(instance)}
                aria-describedby={DraftHintId(instance)}
                rows="3"
                on:input={js::edited(target, editing, ready, signal)}
            ></textarea>
            <p id={DraftHintId(instance)}>"Local to this preview; not saved with the deck."</p>
            <p ref={editing} hidden>"Editing..."</p>
            <p ref={ready} hidden role="status">"Draft updated in this page."</p>
            <PreviewHelp />
        </fieldset>
    }
}
