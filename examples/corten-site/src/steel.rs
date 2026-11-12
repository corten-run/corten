//! The third layer: the server. Its own readings streamed live, the response this page was sent,
//! read back with the defaults `App` puts around every route in it, the same address answering
//! as JSON, and the one file it all is.
use corten::prelude::*;

use crate::{
    Here, Msg, layout,
    looks::{Built, Slab},
    url,
    works::{Machine, Pulse},
    world::{Layer, Opening},
};

/// The headers this page is answered with, and what each is there for. All but the last are
/// `App`'s defaults (`docs/guide/app.md`); the values are read back from the response itself.
pub(crate) const HEADERS: [(&str, &str); 9] = [
    (
        "content-security-policy",
        "No inline script or style runs, this page's included, and scripts load from this origin alone. Trusted Types guard what a script may write into the page.",
    ),
    ("cache-control", "One reader's page is never handed to another. A handler says so when an answer is for everyone."),
    ("etag", "A reload of a page that has not changed is answered 304, with no body."),
    ("content-encoding", "zstd, Brotli or gzip, whichever your browser asked for. One feature turns it on."),
    ("vary", "The page, a patch of it and its JSON share this address, and a cache keeps them apart."),
    ("x-content-type-options", "A file is what the server says it is, never what it looks like."),
    ("cross-origin-opener-policy", "A window another site opens gets no handle on this one."),
    ("permissions-policy", "Camera, microphone, location and the rest stay off until the app asks for one."),
    ("server-timing", "This site's own: a short middleware times each request, and the strip at the bottom reads it back."),
];

#[component(css)]
pub fn Steel<'a>(here: Here<'a>, pulse: &'a Pulse, binary_bytes: u64, machine: &'a Machine, t: Msg) -> impl Render {
    html! {
        <Opening
            layer={Layer::Steel}
            place="Layer 3 of 3"
            name="Steel"
            claim="Rust underneath, and one server for every surface."
        />
        <div class={Live}>
            <div class={Slab {}}>
                <h3>"Live data is patches"</h3>
                <p>
                    "These are the readings of the server you are reading from, streamed as HTML. The runtime swaps each one in by its id, and this page has no script of its own behind them. The page it times is this one, 1,000 wall tiles and three files of source in each render: a heavier page than the item page the certificate measures."
                </p>
                <p>
                    "Open this page in a second tab and the count of pages following goes up in both. Close it, and the stream's signal aborts on the server: the count comes back down. A stream carries a cursor, so a reconnect resumes where it left off."
                </p>
                <Built on={&["Server-sent events", "Last-Event-ID", "AbortSignal"][..]} />
            </div>
            <corten-live src={url::Readings} since={pulse.beat}><Readout pulse={pulse} /></corten-live>
        </div>
        <div class={Sent}>
            <div class={Slab {}}>
                <h3>"Production defaults, in the response you are reading"</h3>
                <p>
                    "This is what this server answers your browser with for this page: the headers of a second request, made as you reached here. An app is "
                    <code>"App::new(routes)"</code> " and " <code>"corten::serve"</code>
                    ", and these come with it: compression is one feature, the timing header is this site's own."
                </p>
                <p>
                    "The same address answers a client that asks for JSON with this page's data, so a native screen or an agent reads what a person sees and nothing is scraped from markup. Agents can also be given an app's actions as Model Context Protocol tools."
                </p>
                <p>
                    "Not in a header: a form another site posts is refused before its handler runs, "
                    <code>"/health/live"</code> " and " <code>"/health/ready"</code>
                    " answer a load balancer, a shutdown lets open requests finish and ends streams first, and every failure is answered in the app's own layout."
                </p>
                <Built on={&["HTTP caching", "Content negotiation", "CSP and Trusted Types", "Fetch Metadata"][..]} />
            </div>
            <Answer here={here} t={t} />
        </div>
        <div class={Binary}>
            <p class={Weight}>
                if binary_bytes > 0 {
                    {megabytes(binary_bytes)}
                    " MiB"
                } else {
                    "One file"
                }
            </p>
            <div class={Slab {}}>
                <h3>"One binary"</h3>
                <p>
                    "That is the whole of this site: the server, the runtime, this page's scripts, styles and images, compiled into one program. There is no JavaScript build step or bundler in a Corten app, and "
                    <code>"static/"</code> " ships inside the binary."
                </p>
                if machine.memory_bytes > 0 {
                    <p>
                        "The machine serving you this has " {machine.cpus}
                        if machine.cpus == 1 {
                            " CPU"
                        } else {
                            " CPUs"
                        }
                        " and " {megabytes(machine.memory_bytes)} " MiB of memory, by its own count"
                        for named in machine.named.iter() {
                            ": " {named.as_str()}
                        }
                        ". The readings above say how much of that this server holds."
                    </p>
                }
            </div>
        </div>
    }
}

/// A size in mebibytes with one decimal, as text: 6291456 is `6.0`.
fn megabytes(bytes: u64) -> String {
    let tenths = (bytes * 10 + 524_288) / 1_048_576;
    format!("{}.{}", tenths / 10, tenths % 10)
}

/// How long the server has been up, as a clock: `1:02:03`, or `2:03` in its first hour.
fn clock(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 { format!("{hours}:{minutes:02}:{seconds:02}") } else { format!("{minutes}:{seconds:02}") }
}

/// The readout's id: each fragment of the stream replaces the element that has it.
#[derive(Id)]
pub struct ReadoutId;

/// The server's readings. Drawn by the page, then by every fragment `/live/works` streams; a
/// number that moved since the last reading is drawn hot, and cools.
#[component(css)]
pub fn Readout<'a>(pulse: &'a Pulse) -> impl Render {
    html! {
        <dl id={ReadoutId} class={Readout}>
            <div class={Gauge}>
                <dt>"Up for"</dt>
                <dd class={Figure}>{clock(pulse.beat)}</dd>
            </div>
            <div class={Gauge}>
                <dt>"Pages rendered"</dt>
                <dd class={(Figure, pulse.moved.pages.then_some(Hot))}>{pulse.pages}</dd>
            </div>
            <div class={Gauge}>
                <dt>"Last page rendered in"</dt>
                <dd class={(Figure, pulse.moved.render.then_some(Hot))}>
                    if pulse.render_micros > 0 {
                        {pulse.render_micros}
                        <span class={Unit}>" µs"</span>
                    } else {
                        "none yet"
                    }
                </dd>
            </div>
            <div class={Gauge}>
                <dt>"Pages following this stream"</dt>
                <dd class={(Figure, pulse.moved.followers.then_some(Hot))}>{pulse.followers}</dd>
            </div>
            <div class={Gauge}>
                <dt>"Plates struck"</dt>
                <dd class={(Figure, pulse.moved.plates.then_some(Hot))}>{pulse.plates}</dd>
            </div>
            if pulse.held_bytes > 0 {
                <div class={Gauge}>
                    <dt>"Memory this server holds"</dt>
                    <dd class={Figure}>{megabytes(pulse.held_bytes)} <span class={Unit}>" MiB"</span></dd>
                </div>
            }
        </dl>
    }
}

/// What this page's address is answered with, read back from a second request: each header
/// `App` answers with, its value as the reader's browser got it, and what it is there for; then
/// the same address asked for JSON.
/// Only a script can read a response, so the values are written in where one runs (`answer.js`,
/// once the reader reaches this), and the commands that show the same stand where none does.
#[component(css, js)]
pub(crate) fn Answer<'a>(here: Here<'a>, t: Msg) -> impl Render {
    let (status, value, json, said, failed) = refs();
    let (absent, read, answered) = (t.answer_absent(), t.answer_read(), t.js().answer_status());
    let address = layout::origin().unwrap_or("https://the-address-of-this-page");
    html! {
        <div class={Answer} on:connect={js::read(scope, status, value, json, said, failed, crate::page(), absent, read, answered, signal)}>
            <figure class={Asked}>
                <figcaption class={Ask}>
                    <code class={Line}>"GET /"</code>
                    <span>"as your browser asks"</span>
                    <output ref={status} class={Status}></output>
                </figcaption>
                <dl class={Heads}>
                    for (name, note) in HEADERS {
                        <div class={Head}>
                            <dt class={Name}>{name}</dt>
                            <dd ref={value} class={Value} data-header={name}></dd>
                            <dd class={Note}>{note}</dd>
                        </div>
                    }
                </dl>
                if here.bare {
                    <p class={Unread}>
                        "A script writes each header's value in. With this page's scripts blocked, read them yourself: "
                        <code>"curl -sI --compressed " {address} "/"</code>
                    </p>
                } else {
                    <noscript>
                        <p class={Unread}>
                            "A script writes each header's value in. Without one, read them yourself: "
                            <code>"curl -sI --compressed " {address} "/"</code>
                        </p>
                    </noscript>
                }
            </figure>
            <figure class={Asked}>
                <figcaption class={Ask}>
                    <code class={Line}>"GET /"</code>
                    <span>"as an agent asks, with"</span>
                    <code class={Line}>"Accept: application/json"</code>
                </figcaption>
                <pre ref={json} class={Json} tabindex="0" role="region" aria-label="This page as JSON">
                    <code>"curl -H \"Accept: application/json\" " {address} "/"</code>
                </pre>
            </figure>
            // Says that the answers arrived, for a reader who cannot see them appear.
            <p ref={said} class={Said} role="status"></p>
            <p ref={failed} class={Failed} role="alert" hidden>"The server did not answer. Reload the page to ask again."</p>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_clocks_read_as_written() {
        assert_eq!(megabytes(6_291_456), "6.0");
        assert_eq!(megabytes(7_654_321), "7.3");
        assert_eq!(clock(59), "0:59");
        assert_eq!(clock(3_723), "1:02:03");
    }
}
