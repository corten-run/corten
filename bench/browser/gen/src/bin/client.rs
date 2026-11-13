//! Native Corten markup and generated views for the client-heavy contract.
use corten::{prelude::*, types::Types};
use serde::Deserialize;

#[derive(Deserialize)]
struct RowData {
    id: String,
    label: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CardData {
    id: String,
    price_minor: u32,
}
#[derive(Deserialize)]
struct Initial {
    rows: Vec<RowData>,
    cards: Vec<CardData>,
}
#[derive(Deserialize)]
struct Workload {
    initial: Initial,
}

#[component(view)]
pub fn ClientRow<'a>(id: &'a str, label: &'a str, selected: bool) -> impl Render {
    html! {
        <tr key={id} data-row={id} data-selected={selected}>
            <td>{id}</td>
            <td><button data-select={id}>{label}</button></td>
            <td><button data-remove={id}>"Remove"</button></td>
        </tr>
    }
}
#[component(view)]
pub fn ClientCard<'a>(id: &'a str, price: u32) -> impl Render {
    html! { <div key={id} data-card={id}><b>{id}</b><span>{price}</span></div> }
}

#[component(js)]
fn Client(initial: &Initial) -> impl Render {
    let (body, template, cards, total, filter) = refs();
    html! {
        <section id="screen" on:connect={js::connect(body, template, cards, total, filter, signal)}>
            <nav>
                for kind in ["update-tenth", "swap", "patch-one", "patch-many", "append", "clear", "create-small", "replace-small", "create-large"] {
                    <button id={kind} on:click={js::act(kind)}>{kind}</button>
                }
            </nav>
            <label>"Filter"<input id="filter" ref={filter} on:input={js::filter(target)}></label>
            <button id="sort-asc" on:click={js::sort("asc")}>"Sort ascending"</button>
            <button id="sort-desc" on:click={js::sort("desc")}>"Sort descending"</button>
            <table>
                <tbody ref={body} on:click={js::row(event)}>
                    for r in &initial.rows {
                        <ClientRow id={&r.id} label={&r.label} selected={false} />
                    }
                </tbody>
            </table>
            <template ref={template}><ClientRow id="" label="" selected={false} /></template>
            <button id="tick-small" on:click={js::tick(false)}>"Tick subset"</button>
            <button id="tick-all" on:click={js::tick(true)}>"Tick all"</button>
            <output id="total" ref={total}>{initial.cards.iter().map(|c| c.price_minor).sum::<u32>()}</output>
            <aside ref={cards}>
                for c in &initial.cards { <ClientCard id={&c.id} price={c.price_minor} /> }
            </aside>
        </section>
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, out] = args.as_slice() else { panic!("usage: client <workload.json> <out>") };
    let w: Workload = serde_json::from_str(&std::fs::read_to_string(input).unwrap()).unwrap();
    let out = std::path::Path::new(out);
    std::fs::create_dir_all(out).unwrap();
    let write = |name: &str, text: String| std::fs::write(out.join(name), text).unwrap();
    write("screen.html", Client { initial: &w.initial }.to_html());
    write("views.js", corten::script::views_module(&[ClientRow, ClientCard]).unwrap().unwrap());
    write("views.d.ts", Types::new().components(&[ClientRow, ClientCard]).typescript());
    write("client.footer.js", corten::script::served("client", ""));
}
