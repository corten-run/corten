//! The first layer: what the reader's browser gets. Nothing here is a sample: the page can be
//! asked for with every script blocked, its components are listed with the script each has or
//! has not, and a wall of samples is put in order by the browser, or by the server where no
//! script runs.
use std::sync::LazyLock;

use corten::prelude::*;

use crate::{
    Here, Msg,
    looks::{Built, Slab},
    world::{Layer, Opening, SurfaceId},
};

/// The components of this page that have a script: the component, its script as written, and
/// what the script is for. These are every script the page can run, and the lines and bytes it
/// prints are these files' own (tests hold the list to the directory and to the source).
const SCRIPTED: [(&str, &str, &str, &str); 6] = [
    ("World", "world.js", include_str!("world.js"), "draws the plate behind the page, one WebGL shader"),
    ("Wall", "wall.js", include_str!("wall.js"), "puts the wall's samples in order"),
    ("Apart", "apart.js", include_str!("apart.js"), "follows a name from one file to another"),
    ("Ledger", "ledger.js", include_str!("ledger.js"), "keeps the count along the bottom"),
    ("Answer", "answer.js", include_str!("answer.js"), "reads this page's response back"),
    ("Nameplate", "nameplate.js", include_str!("nameplate.js"), "tells the plate it was struck"),
];

/// The components with no script: a Rust function, and a stylesheet where they have one.
const PLAIN: [&str; 18] = [
    "Layout",
    "Shared",
    "Bar",
    "Foot",
    "Lost",
    "Opening",
    "Slab",
    "Built",
    "Code",
    "Surface",
    "Seam",
    "Breaks",
    "Press",
    "Steel",
    "Readout",
    "Host",
    "Certificate",
    "After",
];

#[component(css)]
pub fn Surface<'a>(here: Here<'a>, t: Msg) -> impl Render {
    let (lines, bytes) =
        SCRIPTED.iter().fold((0, 0), |(lines, bytes), (_, _, source, _)| (lines + source.lines().count(), bytes + source.len()));
    let all = SCRIPTED.len() + PLAIN.len();
    html! {
        <Opening
            layer={Layer::Surface}
            place="Layer 1 of 3"
            name="Surface"
            claim="The part a person touches arrives finished."
        />
        <div class={(Row, Leading)}>
            <div class={Slab {}}>
                <h3>"HTML that works on its own"</h3>
                <p>
                    "Every page arrives rendered. Links are links and forms post, so a page works before its scripts load, and without them."
                </p>
                <p>
                    "Block this page's scripts, then sort the wall below and strike a plate: the server answers a link and a form."
                </p>
                <Built on={&["HTML links and forms", "Content-Security-Policy"][..]} />
            </div>
            <div class={Cut}>
                if here.bare {
                    <p class={State}>"Scripts: blocked"</p>
                    <p class={Told}>
                        "This page came with a policy that forbids every script, and your browser is enforcing it. The plate behind the page is flat and the live numbers do not move. The links and forms still work."
                    </p>
                    <a href={here.scripts(true).at(SurfaceId)} class={Throw}>"Let the scripts run"</a>
                } else {
                    <p class={State}>"Scripts: running"</p>
                    <p class={Told}>
                        "The link below reloads this page under a policy that forbids every script, enforced by your browser."
                    </p>
                    // A page swapped in by the runtime would keep its scripts, so this one loads in full.
                    <a href={here.scripts(false).at(SurfaceId)} class={Throw} data-reload>"Block every script"</a>
                }
            </div>
        </div>
        <div class={(Row, Trailing)}>
            <figure class={Manifest}>
                <figcaption class={Counted}>
                    "This site is " {all} " components. " {SCRIPTED.len()} " have a script."
                </figcaption>
                <table class={Files}>
                    <tbody>
                        for (name, file, source, does) in SCRIPTED {
                            <tr>
                                <th scope="row" class={File}>{name}</th>
                                <td class={Does}><span class={Script}>{file}</span> " " {does}</td>
                                <td class={Lines}>{t.number(source.lines().count())} " lines"</td>
                            </tr>
                        }
                        <tr>
                            <th scope="row" class={File}>{PLAIN.len()} " more"</th>
                            <td class={(Does, Rest)}>{PLAIN.join(", ")}</td>
                            <td class={Lines}>"no script"</td>
                        </tr>
                    </tbody>
                    <tfoot>
                        <tr>
                            <th scope="row" class={File}>"Every script"</th>
                            <td class={Does}>{t.number(bytes)} " bytes as written, comments included"</td>
                            <td class={Lines}>{t.number(lines)} " lines"</td>
                        </tr>
                    </tfoot>
                </table>
            </figure>
            <div class={Slab {}}>
                <h3>"Plain JavaScript where it is fastest"</h3>
                <p>
                    "A component is a Rust function, and one with no script sends no JavaScript. Behavior is a function in a file beside its component, called from the markup by name and served as written, less its comments."
                </p>
                <p>
                    "Under those functions is Corten's runtime, 14.5 KB gzipped, which swaps pages, patches forms and holds live streams. It keeps no virtual DOM, and nothing runs for an element until an event reaches it."
                </p>
                <Built on={&["ES modules", "Import maps", "JSDoc types, checked by TypeScript"][..]} />
            </div>
        </div>
        <div class={Exhibit}>
            <div class={Slab {}}>
                <h3>"The browser acts on what it has"</h3>
                <p>
                    "These 1,000 samples arrived as HTML, each with a reading. The browser has all it needs to put them in order, so no request is sent: the count at the bottom of the window stays where it is."
                </p>
                <p>
                    "The same control is a link: with no script, the server puts them in order and draws the page again."
                </p>
                <Built on={&["The DOM", "Performance timing"][..]} />
            </div>
            <Wall here={here} t={t} />
        </div>
    }
}

/// How many samples the wall holds.
const SAMPLES: u16 = 1000;

/// The readings 0 to 999 in an order that looks like none: shuffled once, the same for every
/// page, so the wall costs a render nothing but writing it.
static READINGS: LazyLock<Vec<u16>> = LazyLock::new(|| {
    let mut readings: Vec<u16> = (0..SAMPLES).collect();
    let mut state: u32 = 0x00C0_47E1;
    for last in (1..readings.len()).rev() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        readings.swap(last, (state >> 8) as usize % (last + 1));
    }
    readings
});

/// The readings in order, for a page that asks the server to sort them.
static SORTED: LazyLock<Vec<u16>> = LazyLock::new(|| (0..SAMPLES).collect());

/// Where the wall is, for the links that sort it on the server.
#[derive(Id)]
pub struct WallId;

/// The wall: each sample a tile whose color is its reading, cold to white-hot. Its controls are
/// links: `wall.js` answers a click in the browser and says how long that took, and where no
/// script runs the link is followed and the server draws the wall in that order. The links
/// are `data-reload`, so the runtime does not fetch their pages ahead of a click.
#[component(css, js)]
pub(crate) fn Wall<'a>(here: Here<'a>, t: Msg) -> impl Render {
    let (grid, readout) = refs();
    let (ordered, scattered, number) = (t.js().wall_ordered(), t.js().wall_scattered(), t.js().number());
    let readings: &[u16] = if here.sorted { &SORTED } else { &READINGS };
    html! {
        <div id={WallId} class={Wall}>
            <div class={Controls}>
                <a
                    href={here.wall(true).at(WallId)}
                    data-reload
                    class={Press}
                    on:click={js::order(event, grid, readout, ordered, number)}
                >
                    "Put them in order"
                </a>
                <a
                    href={here.wall(false).at(WallId)}
                    data-reload
                    class={Press}
                    on:click={js::scatter(event, grid, readout, scattered, number)}
                >
                    "Scatter them"
                </a>
                <output ref={readout} class={Readout}>
                    if here.sorted {
                        "Put in order by the server: one request, and the page drawn again."
                    }
                </output>
            </div>
            <div ref={grid} class={Grid} role="img" aria-label="1,000 samples, each colored by its reading">
                for reading in readings {
                    <i
                        class={(
                            Tile,
                            match reading * 12 / SAMPLES {
                                0 => Heat0,
                                1 => Heat1,
                                2 => Heat2,
                                3 => Heat3,
                                4 => Heat4,
                                5 => Heat5,
                                6 => Heat6,
                                7 => Heat7,
                                8 => Heat8,
                                9 => Heat9,
                                10 => Heat10,
                                _ => Heat11,
                            },
                        )}
                        data-reading={*reading}
                    ></i>
                }
            </div>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The files in `src/` whose names end with `ending`.
    fn written(ending: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src"))
            .expect("src/ is read")
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.ends_with(ending))
            .collect();
        names.sort();
        names
    }

    /// The page says these are every script it runs, so a script added to `src/` joins the list.
    #[test]
    fn the_list_is_every_script() {
        let mut listed: Vec<&str> = SCRIPTED.iter().map(|&(_, file, ..)| file).collect();
        listed.sort_unstable();
        assert_eq!(written(".js"), listed);
        for (name, file, ..) in SCRIPTED {
            assert_eq!(format!("{}.js", name.to_lowercase()), file);
        }
    }

    /// The page counts its components and says which have a script, so the source is read for
    /// every `#[component]` and whether it names `js`.
    #[test]
    fn the_list_is_every_component() {
        let (mut scripted, mut plain) = (Vec::new(), Vec::new());
        for file in written(".rs") {
            let source =
                std::fs::read_to_string(format!("{}/src/{file}", env!("CARGO_MANIFEST_DIR"))).expect("a source file is read");
            let lines: Vec<&str> = source.lines().collect();
            for (at, line) in lines.iter().enumerate() {
                if !line.starts_with("#[component") {
                    continue;
                }
                // The function is the next line that declares one, under any docs or attributes.
                let named = lines[at + 1..].iter().find_map(|below| Some(below.split_once("fn ")?.1));
                let name: String =
                    named.expect("a component is a function").chars().take_while(char::is_ascii_alphanumeric).collect();
                if line.contains("js") { scripted.push(name) } else { plain.push(name) }
            }
        }
        let sorted = |mut names: Vec<String>| {
            names.sort();
            names
        };
        assert_eq!(sorted(scripted), sorted(SCRIPTED.iter().map(|&(name, ..)| name.to_string()).collect()));
        assert_eq!(sorted(plain), sorted(PLAIN.iter().map(|name| name.to_string()).collect()));
    }
}
