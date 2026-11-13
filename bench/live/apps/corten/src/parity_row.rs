use corten::prelude::*;

#[component(view)]
pub fn ParityRow<'a>(id: &'a str, version: u64, price_cents: u64, quantity: u64) -> impl Render {
    html! {
        <tr key={id}>
            <td>{id}</td>
            <td>{version}</td>
            <td>{price_cents}</td>
            <td>{quantity}</td>
        </tr>
    }
}
