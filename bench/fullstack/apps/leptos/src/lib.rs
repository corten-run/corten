#![recursion_limit = "256"]
pub mod app;
pub mod catalog;
pub mod catalog_page;
pub mod marketplace;
pub mod marketplace_page;
pub mod model;

#[cfg(feature = "hydrate")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(app::App);
    // hydrate_body returns once the page is interactive; the browser benchmark reads this mark.
    if let Some(window) = web_sys::window() {
        let now = window.performance().map(|p| p.now()).unwrap_or(0.0);
        let _ = js_sys::Reflect::set(&window, &"__hydratedAt".into(), &now.into());
    }
}
