//! Looks several layers share: classes for an element the page writes, and the line that names
//! what a part of the page is built on.
use corten::prelude::*;

/// A charcoal plate with a rust edge: where reading text sits on the textured layers.
#[component(css)]
pub fn Slab() -> impl ClassList {
    Slab
}

/// The standards a part of the page stands on, named under it. They are the thread through the
/// page: each thing it shows working is the browser's or HTTP's own, with Corten's types on it.
#[component(css)]
pub fn Built<'a>(on: &'a [&'a str]) -> impl Render {
    html! {
        <div class={Built}>
            <span class={Lead}>"Built on"</span>
            <ul class={Names}>for name in on { <li class={Name}>{*name}</li> }</ul>
        </div>
    }
}
