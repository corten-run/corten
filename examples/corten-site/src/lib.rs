//! Corten's landing page, as a Corten app. One page: a core sample through the mark's three
//! layers, with the framework's claims shown working on the page that makes them.
//!
//! | Route | Piece |
//! |---|---|
//! | `GET /` | `req.screen`: the page for a browser, its data as JSON for `Accept: application/json` |
//! | `POST /strike` | one form's handler: a patch with JavaScript, a redirect back to the page without |
//! | `GET /live/works` | the server's own readings, streamed to `<corten-live>` |
//! | every request | `Timed`: a middleware that says in `Server-Timing` how long the app took |
//! | `GET /robots.txt` | every address may be read; a struck plate's page names the page as its canonical |
//!
//! Modules are declared here only; `src/main.rs` serves `app()`.

mod after;
mod apart;
mod cert;
mod code;
mod cuts;
#[cfg(test)]
mod held;
mod layout;
mod ledger;
mod links;
mod looks;
mod seam;
mod steel;
mod surface;
mod works;
mod world;

use std::time::Instant;

use corten::{
    Component, LiveResponse, LiveSince,
    http::{HeaderValue, Request, Response},
    prelude::*,
    security::Policy,
    seo,
};

use crate::{
    layout::Layout,
    seam::{Nameplate, NameplateId, Plate, app_name},
    works::Works,
};

corten::i18n::messages! {
    /// The text a script fills in: the readouts' sentences, in the page's locale.
    pub struct Msg { "en" => "locales/en.json" }
}

/// The commit this site was built from: named on its certificate and its plates.
pub const HEAT: &str = env!("CORTEN_SITE_HEAT");

/// Whether the tree it was built from had changes that commit does not hold.
pub const DIRTY: bool = !env!("CORTEN_SITE_DIRTY").is_empty();

/// The words on the plate at the top of the page, which its JSON carries too.
const TAGLINE: &str = "Speed that endures.";

/// The page's title: what a tab, a search result and a shared link say.
const TITLE: &str = "Corten: fast web apps, Rust on the server and plain JavaScript in the browser";

/// Every URL the site serves, with the handler that serves it.
#[corten::routes(state = Works)]
pub mod url {
    /// The page. `plate` is the app name a reader struck without JavaScript, drawn on the plate;
    /// `scripts=off` asks for the page with every script blocked, and `wall=sorted` for the wall
    /// of samples put in order by the server, which is what its link does where no script runs.
    #[route("/", get = home)]
    pub struct Home<'a> {
        pub plate: Option<&'a str>,
        pub scripts: Option<&'a str>,
        pub wall: Option<&'a str>,
    }

    #[route("/strike", post = strike)]
    pub struct Strike;

    #[route("/live/works", get = readings)]
    pub struct Readings;

    #[route("/robots.txt", get = robots)]
    pub struct Robots;
}

/// The page as it is first asked for: the one address to share and to index.
pub const fn page() -> url::Home<'static> {
    url::Home { plate: None, scripts: None, wall: None }
}

/// How the page was asked for, which its own links carry on.
#[derive(Clone, Copy, Default)]
pub struct Here<'a> {
    pub plate: Option<&'a str>,
    /// Every script is blocked, by a policy the page carries.
    pub bare: bool,
    /// The server put the wall's samples in order.
    pub sorted: bool,
}

impl<'a> Here<'a> {
    fn link(self) -> url::Home<'a> {
        url::Home { plate: self.plate, scripts: self.bare.then_some("off"), wall: self.sorted.then_some("sorted") }
    }

    /// This page with its scripts running, or with every one blocked.
    pub fn scripts(self, run: bool) -> url::Home<'a> {
        Here { bare: !run, ..self }.link()
    }

    /// This page with the wall in order, or as it first comes.
    pub fn wall(self, sorted: bool) -> url::Home<'a> {
        Here { sorted, ..self }.link()
    }
}

/// Times each request and says so in `Server-Timing`, the header browsers already read: the
/// strip at the bottom of the page shows it back from the browser's own timings.
pub struct Timed;

impl Middleware for Timed {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        let began = Instant::now();
        let mut res = next.run(req).await;
        let micros = began.elapsed().as_micros();
        if let Ok(took) = HeaderValue::from_str(&format!("app;dur={}.{:03}", micros / 1000, micros % 1000)) {
            res.headers_mut().insert("server-timing", took);
        }
        res
    }
}

/// Every component with a stylesheet or a script of its own.
const COMPONENTS: &[Component] = &[
    layout::Bar,
    layout::Foot,
    looks::Slab,
    looks::Built,
    code::Code,
    world::World,
    ledger::Ledger,
    surface::Surface,
    surface::Wall,
    seam::Seam,
    apart::Apart,
    seam::Press,
    seam::Nameplate,
    steel::Steel,
    steel::Readout,
    steel::Answer,
    cert::Certificate,
    after::After,
    layout::Lost,
];

/// The most connections held at once unless `MAX_CONNECTIONS` says otherwise. Every open page
/// holds one for its live stream, so the limit is what many idle readers can take of the server.
const CONNECTIONS: usize = 4096;

/// The site: its routes, its files, its components and the task that reads the server.
pub fn app() -> App<Timed> {
    around(Works::new(), over_https(std::env::var("HTTPS").ok().as_deref()))
}

/// Whether the site is served over HTTPS, from what `HTTPS` is set to: only `1` says so.
fn over_https(set: Option<&str>) -> bool {
    set == Some("1")
}

/// The site around one server's counts, which a test keeps hold of, served over HTTPS or not.
fn around(works: Works, https: bool) -> App<Timed> {
    let reading = works.clone();
    let connections = std::env::var("MAX_CONNECTIONS").ok().and_then(|n| n.trim().parse().ok()).filter(|&n| n > 0);
    // A site served over HTTPS tells browsers to use it from then on.
    let policy = if https { Policy::new().hsts() } else { Policy::new() };
    App::new(url::router(works))
        .assets(layout::Static)
        .error_page(layout::error_page, ())
        .policy(policy)
        // The one form here sends a name of 32 characters.
        .body_limit(16 << 10)
        .max_connections(connections.unwrap_or(CONNECTIONS))
        .components(COMPONENTS)
        .task("works", move |signal| reading.run(signal))
        .middleware(Timed)
}

/// What a native client or an agent is given at the page's address: the values the page shows
/// that are data rather than prose, from the same constants and readings the view draws.
#[derive(ToJson)]
struct Sheet<'a> {
    name: &'static str,
    tagline: &'static str,
    summary: &'static str,
    /// The commit the site was built from.
    heat: &'static str,
    measurements: Vec<Measurement>,
    start: [&'static str; 5],
    /// The app name struck on the page's plate, when its address carries one.
    plate: Option<&'a str>,
    server: Server,
}

#[derive(ToJson)]
struct Measurement {
    what: &'static str,
    result: &'static str,
}

/// The server's readings when the page was drawn.
#[derive(ToJson)]
struct Server {
    up_seconds: u64,
    pages_rendered: u64,
    last_render_micros: u64,
    plates_struck: u64,
    pages_following: u64,
    /// Over the time since the reading before, and since the server started.
    pages_a_second: u64,
    most_pages_following: u64,
    /// The memory the server holds and the machine it is on, as the system counts them; 0 where
    /// it does not say.
    memory_held_bytes: u64,
    machine_memory_bytes: u64,
    machine_cpus: usize,
    /// Whether that memory is a limit the server's control group holds it to, and the CPUs it holds it
    /// to (`null` with no limit). Each decides whose count the reading under it is.
    machine_memory_limited: bool,
    machine_cpu_limit: Option<f64>,
    /// How much is in use: of the machine, by everything on it, or of a limit, by what the
    /// group holds. 0 where the system does not count, and the percent is `null` there and
    /// until two counts are half a second apart.
    machine_memory_used_bytes: u64,
    machine_cpu_used_percent: Option<u8>,
    /// This server's part of the machine's percent: a part of all its CPUs, not of one. `null`
    /// under a CPU limit, where the percent above is the server's already.
    cpu_used_percent: Option<u8>,
}

impl<'a> Sheet<'a> {
    fn new(pulse: &works::Pulse, machine: &works::Machine, plate: Option<&'a str>) -> Self {
        Sheet {
            name: "Corten",
            tagline: TAGLINE,
            summary: layout::DESCRIPTION,
            heat: HEAT,
            measurements: cert::MEASURED.iter().map(|&(what, result)| Measurement { what, result }).collect(),
            start: after::START.map(|(command, _)| command),
            plate,
            server: Server {
                up_seconds: pulse.beat,
                pages_rendered: pulse.pages,
                last_render_micros: pulse.render_micros,
                plates_struck: pulse.plates,
                pages_following: pulse.followers,
                pages_a_second: pulse.pages_a_second,
                most_pages_following: pulse.most_followers,
                memory_held_bytes: pulse.held_bytes,
                machine_memory_bytes: machine.memory_bytes,
                machine_cpus: machine.cpus,
                machine_memory_limited: machine.memory_limited,
                machine_cpu_limit: machine.cpu_limit,
                machine_memory_used_bytes: pulse.used.memory_bytes,
                machine_cpu_used_percent: pulse.used.cpu,
                cpu_used_percent: pulse.used.cpu_own,
            },
        }
    }
}

async fn home(req: Req, Params(at): Params<url::Home<'_>>, State(works): State<Works>) -> HtmlResult {
    let began = Instant::now();
    let pulse = works.pulse();
    let name = at.plate.as_deref().map(app_name);
    let plate = match &name {
        Some(name) => Plate::struck(name, 0),
        None => Plate::blank(),
    };
    let here =
        Here { plate: name.as_deref(), bare: at.scripts.as_deref() == Some("off"), sorted: at.wall.as_deref() == Some("sorted") };
    let machine = works.machine();
    let page = req.screen(
        &Sheet::new(&pulse, machine, name.as_deref()),
        home_page(&req, here, &plate, &pulse, works.binary_bytes(), machine),
    );
    // The readout counts pages: the same address asked for as JSON draws none.
    if req.mode != Mode::Data {
        works.rendered(began.elapsed());
    }
    page
}

/// The page: the world, with each layer handed to it as a view.
fn home_page<'a>(
    req: &'a Req,
    here: Here<'a>,
    plate: &'a Plate<'a>,
    pulse: &'a works::Pulse,
    binary_bytes: u64,
    machine: &'a works::Machine,
) -> impl Document + 'a {
    let t: Msg = req.t();
    html! {
        <Layout req={req} title={TITLE} head={html! { <layout::Shared req={req} title={TITLE} bare={here.bare} /> }}>
            <world::World
                req={req}
                here={here}
                pulse={pulse}
                t={t}
                surface={html! { <surface::Surface here={here} t={t} /> }}
                seam={html! { <seam::Seam here={here} plate={plate} /> }}
                steel={html! {
                    <steel::Steel here={here} pulse={pulse} binary_bytes={binary_bytes} machine={machine} t={t} />
                    <cert::Certificate req={req} />
                    <after::After />
                }}
            />
        </Layout>
    }
}

/// The app name a reader wants on a plate.
#[derive(Fields)]
pub struct StrikeForm {
    name: String,
    /// Sent by the page whose scripts are blocked, so the reader comes back to that page.
    #[serde(default)]
    bare: bool,
}

/// Strikes a plate. With JavaScript the runtime swaps the plate in; without it the form posts
/// and the reader is sent back to the page, at the plate. One handler serves both.
async fn strike(req: Req, State(works): State<Works>, Form(form): Form<StrikeForm>) -> HtmlResult {
    let name = app_name(&form.name);
    let plate = Plate::struck(&name, works.struck()).typed(&form.name);
    // With JavaScript: the plate alone, swapped in by its id.
    // Without: the form posts, and the reader lands back on the page at the plate.
    req.patch_or(Nameplate { plate: &plate, patched: true }, || async {
        req.redirect(&Here { plate: Some(&name), bare: form.bare, sorted: false }.wall(false).at(NameplateId))
    })
    .await
}

/// The server's readings as they are taken, for `<corten-live src>`: each is a fragment the
/// runtime swaps in by its id, with the reading's second as its cursor. Every page is sent the
/// same readout, so it is drawn once a reading (`works::Sent`), not once a page.
async fn readings(State(works): State<Works>, since: LiveSince) -> LiveResponse {
    corten::live_watch(works.follow(), since, |sent| sent.pulse.beat, |sent| sent.drawn.to_string())
}

/// Nothing here is kept from a crawler.
async fn robots() -> Public<seo::File> {
    seo::robots(&[], None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_page_renders_every_layer_without_a_script() {
        let page = app().test().get(&page()).await;
        assert_eq!(page.status(), 200);
        let html = page.text();
        for part in ["Speed", "endures.", "Surface", "Seam", "Steel", "Mill test certificate", "corten new my-app"] {
            assert!(html.contains(part), "the page lacks {part}");
        }
        assert!(html.contains(r#"id="nameplate""#) && html.contains("A blank plate."), "{html}");
        // The tiles' own attribute: the wall's source, shown on the page, names it too.
        assert_eq!(html.matches(r#"data-reading=""#).count(), 1000);
        // One banner, one main and one footer, the bar and the footer outside the page's content.
        let (bar, main, foot) = (html.find("<header").unwrap(), html.find("<main").unwrap(), html.rfind("<footer").unwrap());
        assert!(bar < main && html.find("</main>").unwrap() < foot, "the bar and the footer are outside <main>");
        assert!(html.contains(r#"rel="canonical" href="/""#), "{html}");
        // The policy that blocks scripts is asked for, never the default, and when it is there it
        // is ahead of everything the browser loads.
        assert!(!html.contains("http-equiv"), "{html}");
    }

    /// Only a site served over HTTPS says to keep to it: said over plain HTTP, on a machine
    /// with no certificate, it would be a promise nothing keeps.
    #[tokio::test]
    async fn only_a_site_served_over_https_says_to_keep_to_it() {
        let kept = corten::http::header::STRICT_TRANSPORT_SECURITY;
        let secure = around(Works::new(), true).test().get(&page()).await;
        assert!(secure.headers().get(&kept).is_some_and(|value| value.to_str().is_ok_and(|value| value.starts_with("max-age="))));
        let plain = around(Works::new(), false).test().get(&page()).await;
        assert!(plain.headers().get(&kept).is_none());
        assert!(over_https(Some("1")));
        assert!(!over_https(Some("0")) && !over_https(Some("")) && !over_https(None));
    }

    /// The headers the page lists and explains, each on the answer a browser's request gets.
    #[tokio::test]
    async fn the_headers_the_page_lists_are_sent() {
        let page = app().test().get(&page()).header(corten::http::header::ACCEPT_ENCODING, "gzip").await;
        assert_eq!(page.status(), 200);
        for (name, _) in steel::HEADERS {
            assert!(page.headers().contains_key(name), "the answer has no {name} header");
        }
    }

    #[tokio::test]
    async fn a_failed_request_is_answered_in_the_sites_own_page() {
        // A strike with no name is not what the address takes.
        let refused = app().test().post(&url::Strike).await;
        assert!(refused.status().is_client_error(), "{}", refused.status());
        let html = refused.text();
        assert!(html.contains("Not accepted") && html.contains("Back to the surface") && html.contains("<header"), "{html}");
        assert!(!html.contains(r#"rel="canonical""#), "only the page itself is the address to index: {html}");
    }

    #[tokio::test]
    async fn crawlers_are_kept_from_nothing() {
        let robots = app().test().get(&url::Robots).await;
        assert_eq!(robots.status(), 200);
        assert!(robots.text().contains("User-agent: *") && !robots.text().contains("Disallow: /"), "{}", robots.text());
    }

    #[tokio::test]
    async fn the_page_as_json_is_what_the_page_shows() {
        let works = Works::new();
        let app = around(works.clone(), false).test();
        let sheet = app.get(&Here { plate: Some("acme-store"), ..Here::default() }.wall(false)).mode(Mode::Data).await;
        let data = sheet.text();
        for (command, _) in after::START {
            assert!(data.contains(command), "the JSON lacks the command {command}");
        }
        for (what, result) in cert::MEASURED {
            assert!(data.contains(what) && data.contains(result), "the JSON lacks {what}");
        }
        assert!(data.contains(r#""plate":"acme-store""#), "{data}");
        // The deploy asks this for the commit it was built from (.github/workflows/site.yml).
        assert!(data.contains(&format!(r#""heat":"{HEAT}""#)), "{data}");
        assert!(data.contains(&format!(r#""tagline":"{TAGLINE}""#)) && data.contains(layout::DESCRIPTION), "{data}");
        // Asking for the page's data draws no page, so the readout's count stays; the page does.
        assert_eq!(works.pages(), 0);
        let page = app.get(&page()).await;
        assert_eq!((page.status().as_u16(), works.pages()), (200, 1));
        // What the JSON calls the tagline is the words on the plate, and the deploy reads the
        // commit off the page too.
        for word in TAGLINE.split(' ') {
            assert!(page.text().contains(&format!(">{word}</span>")), "the plate lacks {word}");
        }
        assert!(page.text().contains(&format!("built from {HEAT}")), "the certificate does not name {HEAT}");
    }

    /// The JSON's readings are the pulse's, and it says whose count each of the machine's is: a
    /// client told only "41%" could not tell a limit from the machine.
    #[test]
    fn the_json_says_what_the_readout_shows_and_whose_count_it_is() {
        let meminfo = Some("MemTotal:       12250780 kB\nMemAvailable:   8000000 kB\n");
        let pulse = works::Pulse {
            pages_a_second: 12,
            most_followers: 3,
            used: works::Used { cpu: Some(41), cpu_own: None, memory_bytes: 200 << 20 },
            ..works::Pulse::default()
        };
        let held = works::Machine::counted(1, meminfo, Some("536870912\n"), Some("50000 100000\n"));
        let data = Sheet::new(&pulse, &held, None).to_json();
        for part in [
            r#""pages_a_second":12"#,
            r#""most_pages_following":3"#,
            r#""machine_memory_bytes":536870912"#,
            r#""machine_memory_limited":true"#,
            r#""machine_cpu_limit":0.5"#,
            r#""machine_memory_used_bytes":209715200"#,
            r#""machine_cpu_used_percent":41"#,
            r#""cpu_used_percent":null"#,
        ] {
            assert!(data.contains(part), "the JSON lacks {part}: {data}");
        }
        let whole = works::Machine::counted(8, meminfo, None, None);
        let pulse = works::Pulse { used: works::Used { cpu: Some(41), cpu_own: Some(7), memory_bytes: 1 }, ..pulse };
        let data = Sheet::new(&pulse, &whole, None).to_json();
        for part in [r#""machine_memory_limited":false"#, r#""machine_cpu_limit":null"#, r#""cpu_used_percent":7"#] {
            assert!(data.contains(part), "the JSON lacks {part}: {data}");
        }
    }

    #[tokio::test]
    async fn a_strike_is_a_patch_for_the_runtime() {
        let struck = app().test().post(&url::Strike).mode(Mode::Action).field(StrikeForm::FIELDS.name, "Acme Store").await;
        let html = struck.text();
        // The patch is the plate alone: its first element is the one the runtime swaps by id.
        let opening = &html[..html.find('>').unwrap_or(0)];
        assert!(opening.starts_with("<div") && opening.contains(r#"id="nameplate""#), "{html}");
        assert!(html.contains("corten new acme-store") && html.contains("Sent as a patch"), "{html}");
        assert!(html.contains("Struck as acme-store"), "the plate says the name was changed: {html}");
    }

    #[tokio::test]
    async fn a_strike_without_javascript_comes_back_to_the_plate() {
        let app = app().test();
        let posted = app.post(&url::Strike).field(StrikeForm::FIELDS.name, "Acme Store").await;
        assert_eq!(posted.status(), 303);
        let back = posted.headers().get("location").and_then(|to| to.to_str().ok()).unwrap_or_default();
        assert!(back.contains("plate=acme-store") && back.ends_with("#nameplate"), "{back}");
        let page = app.get(&Here { plate: Some("acme-store"), ..Here::default() }.wall(false)).await;
        assert!(page.text().contains("corten new acme-store") && page.text().contains("Drawn with the page"));
    }

    #[tokio::test]
    async fn the_page_with_its_scripts_blocked_carries_the_policy_and_keeps_its_links() {
        let app = app().test();
        let bare = app.get(&Here { bare: true, ..Here::default() }.wall(false)).await;
        let html = bare.text();
        assert!(html.contains(r#"http-equiv="Content-Security-Policy""#) && html.contains("Scripts: blocked"), "{html}");
        // The link that sorts the wall and the form keep the reader on the page without scripts.
        assert!(html.contains("scripts=off&amp;wall=sorted#wall") && html.contains(r#"name="bare""#), "{html}");
        let plain = app.get(&page()).await;
        let html = plain.text();
        assert!(!html.contains("http-equiv") && html.contains(r#"href="/?wall=sorted#wall""#), "{html}");
        let posted = app.post(&url::Strike).field(StrikeForm::FIELDS.name, "Acme").field(StrikeForm::FIELDS.bare, true).await;
        let back = posted.headers().get("location").and_then(|to| to.to_str().ok()).unwrap_or_default();
        assert!(back.contains("plate=acme") && back.contains("scripts=off"), "{back}");
    }

    #[tokio::test]
    async fn the_server_sorts_the_wall_where_no_script_does() {
        let sorted = app().test().get(&Here { sorted: true, ..Here::default() }.wall(true)).await;
        let html = sorted.text();
        let readings: Vec<u16> =
            html.split(r#"data-reading=""#).skip(1).filter_map(|rest| rest.split('"').next()?.parse().ok()).collect();
        assert_eq!(readings, (0..1000).collect::<Vec<u16>>());
    }

    #[tokio::test]
    async fn every_answer_says_how_long_the_app_took() {
        let page = app().test().get(&page()).await;
        let took = page.headers().get("server-timing").and_then(|took| took.to_str().ok()).unwrap_or_default();
        assert!(took.starts_with("app;dur="), "{took}");
    }

    /// The scripts are type-checked against these declarations: the typed event a struck
    /// plate sends is declared from its Rust struct, and this rewrites the file when it changes.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new().components(COMPONENTS).sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }

    #[test]
    fn the_handler_on_the_page_is_the_handler() {
        assert!(include_str!("lib.rs").contains(seam::STRIKE), "the page shows a strike handler this file does not have");
    }
}
