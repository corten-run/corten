use crate::{
    parity::{self, Listing},
    parity_row::ParityRow,
};
use corten::prelude::*;

#[component(js)]
pub fn ParityScreen(initial: &[Listing]) -> impl Render {
    let (body, template, count) = refs();
    html! {
        <section on:connect={js::start(body, template, count, parity::url::Snapshot, signal)}>
            <output ref={count} name="effect-count">"0"</output>
            <table>
                <tbody ref={body}>
                    for row in initial {
                        <ParityRow id={&row.id} version={row.version} price_cents={row.price_cents} quantity={row.quantity} />
                    }
                </tbody>
            </table>
            <template ref={template}><ParityRow id="" version={0} price_cents={0} quantity={0} /></template>
        </section>
    }
}
