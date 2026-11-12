//! The page's world: the plate drawn behind everything (`world.js`), the depth gauge, the
//! tagline stamped into the surface, the three layers the page descends through, and the far
//! side it comes out on. The layers are the mark's: a rust surface, the deep rust under it,
//! charcoal steel at the bottom.
use corten::prelude::*;

use crate::{Here, Msg, after::StartId, layout::Static, ledger::Ledger, links, seam::PlateStruck, works::Pulse};

/// Where each layer starts: the gauge links to them, and the page's own links do.
#[derive(Id)]
pub struct SurfaceId;

#[derive(Id)]
pub struct SeamId;

#[derive(Id)]
pub struct SteelId;

/// Everything on the page. The canvas is the plate; a browser without WebGL 2, or with scripts
/// off, gets each layer's flat color from the stylesheet and the same words.
#[component(css, js)]
pub fn World<'a>(
    req: &'a Req,
    here: Here<'a>,
    pulse: &'a Pulse,
    t: Msg,
    surface: impl Render,
    seam: impl Render,
    steel: impl Render,
) -> impl Render {
    let (plate, line, word, stratum, band) = refs();
    html! {
        <div
            class={World}
            data-flat={here.bare.then_some("")}
            on:connect={js::forge(scope, plate, line, word, stratum, band, signal)}
            on:PlateStruck={js::blow(event)}
        >
            <canvas ref={plate} class={Plate} aria-hidden="true"></canvas>
            <nav class={Gauge} aria-label="Layers">
                <a ref={band} href={SurfaceId.fragment()} class={(Band, BandSurface)}><span>"Surface"</span></a>
                <a ref={band} href={SeamId.fragment()} class={(Band, BandSeam)}><span>"Seam"</span></a>
                <a ref={band} href={SteelId.fragment()} class={(Band, BandSteel)}><span>"Steel"</span></a>
            </nav>
            <section class={Hero}>
                <h1 ref={line} class={Tagline}>
                    <span ref={word} class={(Word, First)}>"Speed"</span>
                    " "
                    <span ref={word} class={(Word, Second)}>"that"</span>
                    " "
                    <span ref={word} class={Word}>"endures."</span>
                </h1>
                <div class={Lede}>
                    <p class={Pitch}>
                        "Corten is a Rust web framework for apps where speed at the user's end matters. The server renders finished HTML, plain JavaScript does what the browser can do alone, and the names the two share are checked when the crate compiles. No WASM, no hydration, no bundler."
                    </p>
                    <div class={Actions}>
                        <a href={StartId.fragment()} class={Primary}>"Start an app"</a>
                        <a href={SurfaceId.fragment()} class={Quiet}>"Go under the surface"</a>
                    </div>
                    <p class={Note}>
                        "This page is a Corten app, and it is the demonstration: everything below is the page itself, working. The strip along the bottom of the window is your own browser's count of what it has cost."
                    </p>
                </div>
            </section>
            <section ref={stratum} id={SurfaceId} class={(Stratum, Surface)}>{surface}</section>
            <section ref={stratum} id={SeamId} class={(Stratum, Seam)}>{seam}</section>
            <section ref={stratum} id={SteelId} class={(Stratum, Steel)}>{steel}</section>
            // The far side of the plate: the sample comes out through rust again.
            <section ref={stratum} class={(Stratum, Far)}>
                <img src={req.asset(Static::MARK_SVG)} alt="" width="274" height="169" class={Mark}>
                <p class={Last}>"Speed that endures."</p>
                <p class={Origin}>
                    "Cor-ten is weathering steel. It is meant to rust, and the rust is what protects it: rust underneath, a thin protective surface on top."
                </p>
                <div class={Actions}>
                    <a href={StartId.fragment()} class={Primary}>"Start an app"</a>
                    <a href={links::getting_started()} class={Quiet}>"Read the guide"</a>
                    <a href={links::repository()} class={Quiet}>"Open the repository"</a>
                </div>
            </section>
            <Ledger here={here} pulse={pulse} t={t} />
        </div>
    }
}

/// Which layer a heading opens, which is how its name is cut into it: stamped dark into the
/// surface's rust, burning through the seam, struck bright into the steel.
#[derive(Clone, Copy)]
pub enum Layer {
    Surface,
    Seam,
    Steel,
}

/// A layer's opening: its place in the stack, its name at the size of a plate marking, and the
/// one sentence it stands for.
#[component(css = World)]
pub fn Opening<'a>(layer: Layer, place: &'a str, name: &'a str, claim: &'a str) -> impl Render {
    let tone = match layer {
        Layer::Surface => Stamped,
        Layer::Seam => Welded,
        Layer::Steel => Struck,
    };
    html! {
        <header class={(Opening, tone)}>
            <p class={Place}>{place}</p>
            <h2 class={Name}>{name}</h2>
            <p class={Claim}>{claim}</p>
        </header>
    }
}
