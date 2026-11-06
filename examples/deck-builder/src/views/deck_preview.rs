use corten::prelude::*;

use super::{
    DraftNotes, PreviewExport,
    draft_notes::{DraftEdited, DraftOpened},
    preview_export::ExportOpened,
};

#[corten::script::event]
pub struct DeckPreviewChanged {
    pub total: u32,
    pub text: String,
}

#[derive(Id)]
struct PreviewEditorId<'a>(&'a str);
#[derive(Id)]
struct PreviewSummaryId<'a>(&'a str);
#[derive(Id)]
struct EditorExportId<'a>(&'a str);
#[derive(Id)]
struct SummaryExportId<'a>(&'a str);

/// The durable owner of one preview's mode and draft, above the replaceable branches.
#[component(css, js)]
pub fn DeckPreview(root: Ref<el::HTMLElement>, instance: &str, label: &str, total: u32, text: &str) -> impl Render {
    let (host, editor, summary, controls, edit_button, summary_button, exports) = refs();
    let parts = js::Parts { host, editor, summary, controls, edit_button, summary_button, exports };
    html! {
        <section
            ref={root}
            class={Preview}
            aria-label={label}
            on:connect={js::start(parts, total, text)}
            on:DeckPreviewChanged={js::changed(event, parts)}
            on:DraftEdited={js::edited(event)}
            on:DraftOpened={js::restoreNote(event)}
            on:ExportOpened={js::restoreExport(event)}
        >
            <h3>{label}</h3>
            <div ref={controls} hidden>
                <button ref={edit_button} type="button" aria-pressed="true" on:click={js::edit(parts)}>"Edit draft"</button>
                <button ref={summary_button} type="button" aria-pressed="false" on:click={js::summarize(parts)}>"Summary"</button>
            </div>
            <div ref={host}><DeckEditor instance={instance} total={total} text={text} field={exports} /></div>
            <template ref={editor}><DeckEditor instance={instance} total={0} text="" field={exports} /></template>
            <template ref={summary}>
                <DeckSummary instance={instance} saved_total={0} text="" field={exports} />
            </template>
        </section>
    }
}

#[component(view)]
pub fn DeckEditor(instance: &str, total: u32, text: &str, field: Ref<el::HTMLTextAreaElement>) -> impl Render {
    html! {
        <div id={PreviewEditorId(instance)}>
            <p><strong>{total}</strong>" cards in this draft."</p>
            <DraftNotes instance={instance} />
            <PreviewExport id={EditorExportId(instance)} text={text} field={field} />
        </div>
    }
}

#[component(view)]
pub fn DeckSummary(instance: &str, saved_total: u32, text: &str, field: Ref<el::HTMLTextAreaElement>) -> impl Render {
    html! {
        <div id={PreviewSummaryId(instance)}>
            <p><strong>{saved_total}</strong>" cards ready to export."</p>
            <PreviewExport id={SummaryExportId(instance)} text={text} field={field} />
        </div>
    }
}

/// A grandchild with a document listener, removed when its draft branch leaves.
#[component(js)]
pub fn PreviewHelp() -> impl Render {
    html! {
        <details on:document:keydown={js::close(event, target)}>
            <summary>"About this draft"</summary>
            <p>"Notes stay in this preview while you switch views. Escape closes this explanation."</p>
        </details>
    }
}
