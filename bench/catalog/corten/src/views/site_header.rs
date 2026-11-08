use crate::routes;
use corten::prelude::*;

#[component(css)]
pub fn SiteHeader() -> impl Render {
    html! { <header class={Bar}><a href={routes::Home}>"Card Market"</a></header> }
}
