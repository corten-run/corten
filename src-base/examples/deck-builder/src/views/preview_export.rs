use corten::prelude::*;
use corten_ui::CopyButton;

#[corten::script::event]
pub struct ExportOpened {}

/// A reusable, ID-based child, including the kit's own stateful CopyButton grandchild.
#[component(js)]
pub fn PreviewExport<I: Id>(id: I, text: &str, field: Ref<el::HTMLTextAreaElement>) -> impl Render {
    html! {
        <div>
            <label for={&id}>"Export text"</label>
            <textarea
                ref={field}
                id={&id}
                readonly
                rows="4"
                on:connect={js::start(target)}
            >
                {text}
            </textarea>
            <CopyButton text={&id} label="Copy export" copied="Copied export" class={()} />
        </div>
    }
}
