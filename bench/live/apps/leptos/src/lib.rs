use leptos::prelude::*;
use serde::{Deserialize, Serialize};

#[cfg(feature = "ssr")]
pub mod server;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Listing {
    pub id: String,
    pub version: u64,
    pub price_cents: u64,
    pub quantity: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub seq: u64,
    pub effect_id: String,
    pub key: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<Listing>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub through: u64,
    pub rows: Vec<Listing>,
    pub work: Work,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Work {
    pub reads: u64,
    pub rows: usize,
}

// The initial HTML and hydrated component use the same Leptos server function.
#[server]
pub async fn initial_snapshot() -> Result<Snapshot, ServerFnError> {
    let state = expect_context::<server::Shared>();
    Ok(state.0.lock().unwrap().snapshot())
}

pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <title>"Native Leptos live parity"</title>
                <HydrationScripts options/>
                <script type="module" src="/bridge.js"></script>
            </head>
            <body><App/></body>
        </html>
    }
}

#[component]
pub fn App() -> impl IntoView {
    let initial = Resource::new(|| (), |_| initial_snapshot());
    view! {
        <Suspense fallback=|| view! { <p>"Loading native screen"</p> }>
            {move || initial.get().map(|result| match result {
                Ok(snapshot) => view! { <Screen initial=snapshot/> }.into_any(),
                Err(error) => view! { <p>{error.to_string()}</p> }.into_any(),
            })}
        </Suspense>
    }
}

#[component]
fn Screen(initial: Snapshot) -> impl IntoView {
    let rows = RwSignal::new(initial.rows);
    let count = RwSignal::new(0_u64);
    #[cfg(feature = "hydrate")]
    {
        CLIENT.with(|client| *client.borrow_mut() = Some((rows, count)));
        let owner = Owner::current().unwrap();
        CLEANUP.with(|cleanup| *cleanup.borrow_mut() = Some(Box::new(move || owner.cleanup())));
        on_cleanup(|| {
            CLIENT.with(|client| *client.borrow_mut() = None);
            if let Some(window) = web_sys::window() {
                if let Ok(callback) = js_sys::Reflect::get(&window, &"nativeLeptosCleanup".into()) {
                    if let Some(callback) = callback.dyn_ref::<js_sys::Function>() {
                        let _ = callback.call0(&wasm_bindgen::JsValue::NULL);
                    }
                }
            }
        });
        Effect::new(move |_| {
            let _ = count.get();
            if let Some(window) = web_sys::window() {
                let _ = js_sys::Reflect::set(&window, &"nativeLeptosReady".into(), &true.into());
            }
        });
    }
    view! {
        <main>
            <h1>"Native Leptos live parity"</h1>
            <output id="effect-count">{move || count.get()}</output>
            <ul id="listings">
                <For
                    each=move || rows.with(|rows| rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>())
                    key=|id| id.clone()
                    children=move |id: String| {
                        let key = id.clone();
                        let row = Signal::derive(move || rows.with(|rows| rows.iter().find(|row| row.id == key).cloned().unwrap_or_default()));
                        view! {
                            <li data-key=id>
                                <span class="version">{move || row.get().version}</span>" "
                                <span class="price">{move || row.get().price_cents}</span>" "
                                <span class="quantity">{move || row.get().quantity}</span>
                            </li>
                        }
                    }
                />
            </ul>
        </main>
    }
}

#[cfg(feature = "hydrate")]
use wasm_bindgen::{JsCast, prelude::*};
#[cfg(feature = "hydrate")]
thread_local! {
    static CLIENT: std::cell::RefCell<Option<(RwSignal<Vec<Listing>>, RwSignal<u64>)>> = const { std::cell::RefCell::new(None) };
    static CLEANUP: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(feature = "hydrate")]
#[wasm_bindgen]
pub fn hydrate() {
    console_error_panic_hook::set_once();
    leptos::mount::hydrate_body(App);
}

// These functions change signals only. Leptos owns every DOM insertion/update/removal.
#[cfg(feature = "hydrate")]
#[wasm_bindgen]
pub fn replace_snapshot(json: &str) -> Result<(), JsValue> {
    let snapshot: Snapshot = serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    CLIENT.with(|client| {
        let client = client.borrow();
        let (rows, _) = client.as_ref().ok_or_else(|| JsValue::from_str("component is detached"))?;
        rows.set(snapshot.rows);
        Ok(())
    })
}

#[cfg(feature = "hydrate")]
#[wasm_bindgen]
pub fn apply_change(json: &str) -> Result<(), JsValue> {
    let event: Change = serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    CLIENT.with(|client| {
        let client = client.borrow();
        let (rows, count) = client.as_ref().ok_or_else(|| JsValue::from_str("component is detached"))?;
        rows.update(|rows| {
            if event.op == "remove" {
                rows.retain(|row| row.id != event.key);
            } else if let Some(row) = event.row {
                if let Some(old) = rows.iter_mut().find(|old| old.id == event.key) {
                    *old = row;
                } else {
                    rows.push(row);
                }
            }
        });
        count.update(|count| *count += 1);
        Ok(())
    })
}

#[cfg(feature = "hydrate")]
#[wasm_bindgen]
pub fn detach_component() {
    // Cleanup the reactive owner without removing the last visible DOM, so quiescence is observable.
    CLEANUP.with(|cleanup| {
        if let Some(cleanup) = cleanup.borrow_mut().take() {
            cleanup();
        }
    });
}
