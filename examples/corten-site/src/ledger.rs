//! The strip along the bottom of the page: what the page has cost, counted by the reader's own
//! browser. The server's time for this request comes back in `Server-Timing`; the requests and
//! bytes are the browser's resource timings. Everything the reader does on the page that sends a
//! request moves it, and everything that does not leaves it where it was.
use corten::prelude::*;

use crate::{Here, Msg, works::Pulse};

#[component(css, js)]
pub fn Ledger<'a>(here: Here<'a>, pulse: &'a Pulse, t: Msg) -> impl Render {
    let (drew, load, since, last) = refs();
    let said = (t.js().ledger_drew(), t.js().ledger_load(), t.js().ledger_since(), t.js().ledger_last());
    let number = t.js().number();
    html! {
        <aside class={Ledger} aria-label="What this page has cost">
            if here.bare {
                <p class={Cell}>
                    <span class={Key}>"Scripts"</span>
                    <span class={Val}>"all blocked. This is HTML and CSS."</span>
                </p>
                <p class={(Cell, Wide)}>
                    <span class={Key}>"Server"</span>
                    <span class={Val}>"drew the page before yours in " {t.number(pulse.render_micros)} " µs"</span>
                </p>
                <a href={here.scripts(true)} class={Back}>"Let the scripts run"</a>
            } else {
                <div
                    class={Counted}
                    on:connect={js::keep(drew, load, since, last, said.0, said.1, said.2, said.3, number, signal)}
                >
                    <p class={Cell}>
                        <span class={Key}>"Server took"</span>
                        <output ref={drew} class={Val}>{t.number(pulse.render_micros)} " µs, the page before yours"</output>
                    </p>
                    <p class={Cell}>
                        <span class={Key}>"To load"</span>
                        <output ref={load} class={Val}>"counting"</output>
                    </p>
                    <p class={Cell}>
                        <span class={Key}>"Since"</span>
                        <output ref={since} class={Val}>"0 requests"</output>
                    </p>
                    <p class={(Cell, Wide)}>
                        <span class={Key}>"Last request"</span>
                        <output ref={last} class={Val}>"none yet"</output>
                    </p>
                </div>
                <noscript>
                    <p class={Cell}>
                        <span class={Key}>"Scripts"</span>
                        <span class={Val}>"off in your browser. This is HTML and CSS."</span>
                    </p>
                </noscript>
            }
        </aside>
    }
}
