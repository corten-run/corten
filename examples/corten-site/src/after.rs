//! After the layers, still in the steel: what Corten fits and what it does not, what it is
//! against the reader's other choices, how to start, and the order its values are decided in.
use corten::prelude::*;

use crate::{
    code::{Code, Lang},
    links,
};

/// Where the commands are, for the links that say "get started".
#[derive(Id)]
pub struct StartId;

/// The README's quick start: each command, and what the README says beside it.
pub const START: [(&str, &str); 5] = [
    ("cargo install corten-cli", "or cargo binstall corten-cli, for the prebuilt binary"),
    ("npm install --global typescript", "needs Node.js; corten check type-checks the app's scripts with it"),
    ("corten new my-app", ""),
    ("cd my-app", ""),
    ("corten dev", "serves http://localhost:3000 and reloads on save"),
];

/// The same start from a checkout of the repository, which is what this page describes.
const CHECKOUT: &str = "git clone https://github.com/corten-run/corten
cargo install --path corten/crates/corten-cli
corten new my-app --corten-path corten
cd my-app
corten dev
";

const FITS: [&str; 5] = [
    "Stores and marketplaces",
    "Dashboards and admin tools",
    "Rich editing screens",
    "Content with live parts",
    "Teams that want Rust on the server and the platform's own JavaScript in the browser, with types across the seam",
];

const ELSEWHERE: [&str; 4] = [
    "An offline-first app whose data lives on the device. Corten's offline support is a fallback page and cached files.",
    "Server-side TSX or React components.",
    "A pure static site. A static site generator is simpler.",
    "A framework that brings the database, the job queue and the mailer. Corten is the web layer: sessions, sign-in and the data layer are the app's.",
];

/// What a reader should know before choosing, from the README and the design's limits.
const LIMITS: [&str; 4] = [
    "Corten speaks HTTP/1.1. A proxy or CDN in front serves browsers HTTP/2 or HTTP/3, which an app with live streams needs.",
    "Pages swap without a full load where the browser has the Navigation API (Chrome, Edge, Firefox 147 and later, Safari 26.2 and later). Older browsers load each page in full; forms, patches and handlers still work.",
    "A native app shell is planned, not built. Agents are given actions as MCP tools behind the agent feature.",
    "It is 0.2. The API will change before 1.0, and the changelog lists each change.",
];

/// What the reader would otherwise pick, and what is different. Each is a claim the repository
/// makes of Corten; none is a verdict on the other.
const AGAINST: [(&str, &str); 5] = [
    (
        "axum with a template engine",
        "A Rust server either way. Corten adds typed seams between markup, scripts and handlers, form patches, live streams and production defaults. In round r16, axum with Maud rendered more pages a second: 27,327 against Corten's 20,705.",
    ),
    (
        "htmx",
        "The same idea of HTML first: the server sends markup, and the page works without scripts. Corten's behavior is JavaScript functions next to their component, checked against the markup when the crate compiles.",
    ),
    (
        "Leptos, or another WASM framework",
        "Nothing is compiled to WASM and nothing hydrates. The server renders, and a script acts on the page that arrived.",
    ),
    (
        "Next.js, SvelteKit or Nuxt",
        "No hydration and no bundler, and the server is Rust. You give up server-side JSX and the component libraries built for it.",
    ),
    (
        "Rails, Phoenix or Laravel",
        "Corten is the web layer alone. The ORM, the jobs and the mail those bring are yours to choose.",
    ),
];

/// The README's order for when two values conflict, first deciding.
const ORDER: [(&str, &str); 4] = [
    (
        "Correctness and reliability",
        "Following a standard where one fits is part of being correct. A header or format of Corten's own in its place needs a recorded reason.",
    ),
    ("Performance at the user's end", "Measured before and after, with the number that can see the change."),
    (
        "Compile-time safety, and one way to do each thing",
        "A mistake the compiler can catch is a compile error, not a startup panic or a check on every request.",
    ),
    ("Developer convenience", "Last, on purpose."),
];

/// The quick start as a reader types it: each command, with the README's note after it.
fn start() -> String {
    let mut text = String::new();
    for (command, note) in START {
        text.push_str(command);
        if !note.is_empty() {
            text.push_str("  # ");
            text.push_str(note);
        }
        text.push('\n');
    }
    text
}

#[component(css)]
pub fn After() -> impl Render {
    let start = start();
    html! {
        <section class={Fit}>
            <h2 class={Statement}>"Use it where the user's wait is the cost"</h2>
            <div class={Columns}>
                <div class={Column}>
                    <h3 class={Sub}>"Built for"</h3>
                    <ul class={List}>for fit in FITS { <li>{fit}</li> }</ul>
                </div>
                <div class={(Column, Away)}>
                    <h3 class={Sub}>"Look elsewhere for"</h3>
                    <ul class={List}>for other in ELSEWHERE { <li>{other}</li> }</ul>
                </div>
                <div class={(Column, Away)}>
                    <h3 class={Sub}>"Limits today"</h3>
                    <ul class={List}>for limit in LIMITS { <li>{limit}</li> }</ul>
                </div>
            </div>
            <h3 class={Against}>"Against what you would pick instead"</h3>
            <dl class={Others}>
                for (other, differs) in AGAINST {
                    <div class={Other}>
                        <dt>{other}</dt>
                        <dd>{differs}</dd>
                    </div>
                }
            </dl>
        </section>
        <section id={StartId} class={Start}>
            <h2 class={Statement}>"Five commands to a running app"</h2>
            <div class={Begin}>
                <div class={Blocks}>
                    <Code file="" lang={Lang::Shell} source={&start} />
                    <p class={Kept}>
                        "This page describes the repository's main branch, which can be ahead of the latest release. To run exactly what you read here, build from a checkout:"
                    </p>
                    <Code file="from a checkout" lang={Lang::Shell} source={CHECKOUT} />
                </div>
                <div class={Words}>
                    <p>
                        "You need Rust 1.88 or later, and Node.js for the TypeScript that " <code>"corten check"</code>
                        " type-checks an app's scripts with. Nothing is bundled."
                    </p>
                    <p>
                        <code>"corten new"</code>
                        " writes a working app: a page, a form that patches part of the page, a component with a script, a test and a Dockerfile. Its package is "
                        <code>"corten-run"</code> " and its library " <code>"corten"</code>
                        ", and the app's Cargo.toml says so for you."
                    </p>
                    <p>
                        "Corten is 0.2: usable and tested, and built for " <a href={links::chase_sets()}>"Chase Sets"</a>
                        ". The API will change before 1.0, and the " <a href={links::changelog()}>"changelog"</a>
                        " lists what changed."
                    </p>
                    <p class={Ways}>
                        <a href={links::getting_started()} class={Way}>"Read the getting started guide"</a>
                        <a href={links::repository()} class={Way}>"Open the repository"</a>
                    </p>
                    <p class={Next}>
                        "Then read an example: the "
                        <a href={links::watchlist()}>"watchlist"</a>
                        " first, the "
                        <a href={links::card_market()}>"card market"</a>
                        " for every production module, the "
                        <a href={links::auction_room()}>"auction room"</a>
                        " for sign-in and SQLite, and the "
                        <a href={links::deploying()}>"deploying guide"</a>
                        " before it serves anyone."
                    </p>
                </div>
            </div>
        </section>
        <section class={Decided}>
            <h2 class={Statement}>"When two values conflict, this order decides"</h2>
            <ol class={Order}>
                for (value, why) in ORDER {
                    <li class={Rank}>
                        <h3 class={Value}>{value}</h3>
                        <p>{why}</p>
                    </li>
                }
            </ol>
            <p class={Proof}>
                "So the deadline timer that cost 640 ns per request was reworked rather than kept for convenience, and a nicer API that slows every page loses. Every pull request is reviewed against the values, in this order, before it merges."
            </p>
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quick_start_is_the_readmes() {
        let readme = include_str!("../../../README.md");
        for (command, note) in START {
            let line = readme.lines().find(|line| line.starts_with(command));
            let line = line.unwrap_or_else(|| panic!("the README's quick start has no line: {command}"));
            assert!(line.ends_with(note), "the README says something else beside {command}: {line}");
        }
        assert!(start().starts_with("cargo install corten-cli  # or cargo binstall"));
    }
}
