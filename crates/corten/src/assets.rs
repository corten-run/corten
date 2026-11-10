//! Static files with one content version in the URL: `/assets/{version}/style.css`.
//!
//! The app's static directory is compiled into the program by [`embed!`], which gives each file
//! a constant, so a page names one by it and a missing file does not compile:
//!
//! ```
//! corten::assets::embed!(pub struct Static = "src/assets/fixture");
//!
//! # use corten::prelude::*;
//! fn head(req: &Req) -> impl Render + '_ {
//!     html! { <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}> }
//! }
//! let _ = App::new(Routes::new()).assets(Static);
//! ```
//!
//! ```compile_fail,E0599
//! corten::assets::embed!(pub struct Static = "src/assets/fixture");
//!
//! # use corten::prelude::*;
//! fn head(req: &Req) -> impl Render + '_ {
//!     html! { <link rel="stylesheet" href={req.asset(Static::STYLES_CSS)}> }
//! }
//! ```
//!
//! A directory that is not there, or two files with one constant (`item-1.svg` and
//! `item_1.svg`), do not compile, nor does a file name a URL cannot carry as it is (a space,
//! `#`, `?`, `%`; the fixture has `50%.css`):
//!
//! ```compile_fail
//! corten::assets::embed!(pub struct Static = "src/assets/missing");
//! ```
//!
//! ```compile_fail
//! corten::assets::embed!(pub struct Static = "src/assets/clash");
//! ```
//!
//! ```compile_fail
//! corten::assets::embed!(pub struct Static = "src/assets/unsafe");
//! ```
//!
//! Nor does a path outside the directory it names (the crate's root, `..`, an absolute path):
//!
//! ```compile_fail
//! corten::assets::embed!(pub struct Static = "src/..");
//! ```
//!
//! The program is the whole deploy: nothing is read from disk, except under `corten dev`, which
//! reads the directory the macro read, so a file added to it is served without a rebuild. The
//! files are hashed at startup. Every URL carries the
//! hash, so browsers, CDNs and the service worker may cache the files forever, and a deploy
//! that changes any file changes every URL. The version is a directory prefix, not a per-file
//! name, so scripts keep importing each other with relative paths. Handler scripts
//! (`#[component(js)]` and `script!`, compiled into the binary) are served from
//! `scripts/{name}.js` in the same version, the app's typed events from `events.js` (imported as
//! `corten/events`), and the components' stylesheets, joined in the order the app lists them,
//! from `components.css`, except an area's (`Area::components`), which are joined into
//! `sections/{prefix}.css`, and those several areas list, joined into a file the areas share
//! (`sections/search+categories.css`).
//!
//! During a rolling deploy a page from the old version can ask a new server for an old URL. It
//! gets the current file with `Cache-Control: no-cache`, so nothing caches the mismatch.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::body::Bytes;
use axum::{
    extract::Path as UrlPath,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

use crate::{fnv, Component};

pub use corten_macros::embed;

/// A static directory compiled into the program: the struct [`embed!`] declares. Give it to
/// `App::assets`.
pub trait Embed {
    /// Where the macro read the directory, for `corten dev` to read again: its full path in a
    /// debug build, empty in a release build (which never reads the disk).
    const DIR: &'static str;
    /// The struct's path (`shop::views::Static`), which each of its files carries, so a file of
    /// another app's directory is found in debug builds.
    const OWNER: &'static str;
    /// Each file: its path in the directory (`icons/192.png`) and its bytes.
    const FILES: &'static [(&'static str, &'static [u8])];
}

/// A file of the app's static directory, a constant [`embed!`] makes (`Static::STYLE_CSS`).
/// `req.asset(file)` is its versioned URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Asset {
    owner: &'static str,
    path: &'static str,
}

impl Asset {
    #[doc(hidden)]
    pub const fn __embedded(owner: &'static str, path: &'static str) -> Self {
        Asset { owner, path }
    }

    /// Its path in the directory, `icons/192.png`.
    pub const fn path(self) -> &'static str {
        self.path
    }

    /// The `embed!` struct it is a file of (`shop::Static`).
    pub(crate) const fn owner(self) -> &'static str {
        self.owner
    }
}

/// A static file's versioned URL, written where it is used: `/assets/{version}/style.css`.
#[derive(Clone, Copy, Debug)]
pub struct AssetUrl<'a> {
    prefix: &'a str,
    path: &'a str,
}

impl<'a> AssetUrl<'a> {
    /// `/{path}`, for a file no directory serves.
    pub(crate) const fn unserved(path: &'a str) -> Self {
        AssetUrl { prefix: "/", path }
    }

    fn write(&self, out: &mut String) {
        out.push_str(self.prefix);
        crate::view::Render::render(self.path, out);
    }
}

impl std::fmt::Display for AssetUrl<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.prefix)?;
        f.write_str(self.path)
    }
}

impl crate::view::Render for AssetUrl<'_> {
    fn render(&self, out: &mut String) {
        self.write(out)
    }
}

impl crate::view::AttrValue for AssetUrl<'_> {
    fn write_attr(&self, name: &str, out: &mut String) {
        out.push_str(name);
        out.push_str("=\"");
        self.write(out);
        out.push('"');
    }
}

/// The file the components' stylesheets are joined into.
pub const STYLESHEET: &str = "components.css";

/// The rules `components.css` starts with: an element with `hidden`, a closed popover and a
/// closed `<dialog>` are not drawn, whatever `display` a component's rule gives them (a class's
/// `display: grid` otherwise wins over the browser's own rule for each, so a card look on a
/// popover drew it open on every load). `hidden="until-found"` keeps the browser's behavior, so
/// find-in-page still reveals it. A `<dialog popover>` is shown open either way (`showModal()`
/// sets `open`, `showPopover()` makes it `:popover-open`). The popover's test is inside `:where`,
/// a forgiving list, so an engine that cannot read `:popover-open` drops only that rule; each
/// rule starts at an attribute or a tag, so the engine tries it only on those elements. A closing
/// transition of `display` (`allow-discrete`) runs as it would without the rule, as a transition
/// outranks `!important`; a `@keyframes` that animates `display` is held at `none`, and a closed
/// dialog kept drawn to fade out needs the app's own `!important` rule with more weight.
pub(crate) const HIDDEN_RULE: &str = "[hidden]:where(:not([hidden=until-found i])){display:none!important}\n\
    [popover]:where(:not(:popover-open,dialog[open])){display:none!important}\n\
    dialog:where(:not([open],[popover])){display:none!important}\n";

/// The module of the app's typed events, `corten/events`.
pub const EVENTS: &str = "events.js";

/// The module of the app's view classes, `corten/views`.
pub const VIEWS: &str = "views.js";

/// The start of `events.js`: one class per `#[event]`, which bubbles and carries its fields.
const EVENT_CLASS: &str = "// The app's typed events (#[event]), generated by Corten.
const event = (type) =>
  class extends Event {
    constructor(init = {}) {
      super(type, { bubbles: true, composed: true });
      Object.assign(this, init);
    }
  };
";

/// Cache header for a URL that can never change.
pub(crate) const IMMUTABLE: HeaderValue = HeaderValue::from_static("public, max-age=31536000, immutable");

/// The path browsers ask for an icon on their own, for a document that names none (a PDF, an
/// image or JSON opened in a tab), and feed readers and crawlers too.
pub(crate) const FAVICON_PATH: &str = "/favicon.ico";

/// How long a cache keeps the icon at [`FAVICON_PATH`]: a day, since the path never changes as
/// a versioned URL does; with its ETag, a cache then asks again for a 304.
const FAVICON_CACHE: HeaderValue = HeaderValue::from_static("public, max-age=86400");

/// How long a cache keeps the 404 at [`FAVICON_PATH`] when the app has no icon: an hour, so a
/// deploy that adds one is seen soon, by a CDN too.
const NO_FAVICON_CACHE: HeaderValue = HeaderValue::from_static("public, max-age=3600");

/// The route Corten adds at [`FAVICON_PATH`] when no route of the app's is there: the static
/// directory's `favicon.ico` (`image/x-icon`), else its `favicon.svg` (`image/svg+xml`), each
/// with its ETag and a day's cache; with neither, a 404 with no body and an hour's cache. Chosen
/// once, at startup, and no layout read or page runs for it (#1056).
pub(crate) fn favicon<S: Clone + Send + Sync + 'static>(assets: Option<&Arc<Assets>>) -> Router<S> {
    let icon = assets.and_then(|assets| {
        let path = ["favicon.ico", "favicon.svg"].into_iter().find(|path| assets.files.contains_key(*path))?;
        Some((assets.clone(), path))
    });
    Router::new().route(
        FAVICON_PATH,
        get(move |method: Method, headers: HeaderMap| {
            let icon = icon.clone();
            async move {
                match icon {
                    Some((assets, path)) => assets.serve(path, &method, &headers, FAVICON_CACHE, Url::Fixed),
                    None => {
                        let mut res = (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, NO_FAVICON_CACHE)]).into_response();
                        res.extensions_mut().insert(crate::page::AsIs);
                        res
                    }
                }
            }
        }),
    )
}

struct File {
    #[cfg(not(feature = "compress"))]
    body: Bytes,
    #[cfg(feature = "compress")]
    body: crate::compress::Precompressed,
    content_type: &'static str,
    hash: u64,
}

/// A script module's tag in a page's head.
struct ModuleTag {
    name: Box<str>,
    tag: Box<str>,
    /// The preload tag of each module it imports, and theirs, without its own: what a page the
    /// runtime swaps in carries, since the runtime imports the module itself.
    imports: Box<[Box<str>]>,
    /// It imports the typed events, so a page that loads it preloads them.
    imports_events: bool,
    /// It, or a module it imports, imports the views (`corten/views`).
    imports_views: bool,
}

/// A directory of static files served under a versioned prefix. Load it once, at startup.
pub struct Assets {
    mount: String,
    version: String,
    prefix: String,
    scripts_dir: String,
    files: HashMap<String, File>,
    /// Names with a module at `scripts/{name}.js`.
    scripts: std::collections::HashSet<String>,
    /// The components' and `script!` modules: they hand their exports to the runtime as they run, so a
    /// page loads them with a module script of its own.
    registered: std::collections::HashSet<String>,
    /// Each script module's tag in a page's head, sorted by name: a `<script type="module">` for a
    /// registered module, else a `<link rel="modulepreload">`. Made here so a page only looks it up.
    module_tags: Box<[ModuleTag]>,
    /// The views' module preload tag, when the app lists any `#[component(view)]`.
    views_tag: Option<Box<str>>,
    /// The typed events' module preload tag, when a listed script imports any `#[event]`.
    events_tag: Option<Box<str>>,
    /// The joined component stylesheets' URL, when any component has one.
    stylesheet: Option<String>,
    /// Each section stylesheet: the prefixes whose pages link it, its URL and the components in it.
    sections: Vec<Section>,
    /// The `embed!` struct the files came from (`Embed::OWNER`), when the app gave one.
    pub(crate) owner: Option<&'static str>,
}

impl Assets {
    /// Reads every file under `dir` and serves them at `{mount}/{version}/...` (`mount` is
    /// usually `/assets`).
    #[cfg(test)]
    pub(crate) fn load(dir: impl AsRef<Path>, mount: &str) -> io::Result<Self> {
        Self::build(Some(dir.as_ref()), &[], mount)
    }

    /// The files under `dir` (when given), each script at `scripts/{name}.js`, the typed events in
    /// `events.js` and the components' stylesheets joined into `components.css`, served at
    /// `{mount}/{version}/...`. A component listed twice counts once; two different scripts with one
    /// name or two components with one class prefix (`ui::Card` and `admin::Card`) are an error.
    #[cfg(test)]
    pub(crate) fn build(dir: Option<&Path>, components: &[Component], mount: &str) -> io::Result<Self> {
        let files = match dir {
            Some(dir) => read_dir(dir)?,
            None => Vec::new(),
        };
        Self::build_with(files, components, &[], mount)
    }

    /// The files, components and sections, with sections: each section's components are served the same way, but
    /// their stylesheets are joined into `sections/{prefix}.css` instead of `components.css`. A
    /// component several sections list is in one file those sections share,
    /// `sections/{a}+{b}.css`, with the others the same sections share. A component with a
    /// stylesheet is in `components` or in sections, not both, and a token file's (global)
    /// stylesheet only in `components`.
    pub(crate) fn build_with(
        files: Vec<(String, Bytes)>,
        components: &[Component],
        sections: &[(&str, &[Component])],
        mount: &str,
    ) -> io::Result<Self> {
        let mount = mount.trim_end_matches('/');
        assert!(mount.starts_with('/'), "the assets mount is an absolute path, like /assets");
        let mut sources = files;
        sources.reserve(components.len() + 1);
        let clash = |message: String| io::Error::new(io::ErrorKind::AlreadyExists, message);
        // Where each component is listed: 0 is `components`, i + 1 the section i.
        // Each script's typed events follow it, where it is listed.
        let listed = components
            .iter()
            .map(|c| (0, c))
            .chain(sections.iter().enumerate().flat_map(|(i, (_, list))| list.iter().map(move |c| (i + 1, c))))
            .flat_map(|(at, c)| {
                let events = c.script.as_ref().map_or(&[][..], |s| s.events);
                std::iter::once((at, c)).chain(events.iter().map(move |e| (at, e)))
            });
        let place = |at: usize| if at == 0 { "App::components".to_string() } else { format!("the area {}", sections[at - 1].0) };
        // The sections that list each styled component: one that several list is in their shared file.
        let mut listed_in: Vec<(&str, Vec<usize>)> = Vec::new();
        for (i, (_, list)) in sections.iter().enumerate() {
            for c in list.iter().filter(|c| c.style.is_some()) {
                match listed_in.iter_mut().find(|(name, _)| *name == c.name) {
                    Some((_, at)) if !at.contains(&(i + 1)) => at.push(i + 1),
                    Some(_) => {}
                    None => listed_in.push((c.name, vec![i + 1])),
                }
            }
        }
        let mut seen: Vec<(&Component, usize)> = Vec::new();
        // The token files' breakpoints, which an `@media` rule of a component's names (`(--md)`):
        // each name, width and file. Two files may give one name different widths (the kit's
        // theme beside an app's); that stops the app only when a component names it.
        let mut breakpoints: Vec<Breakpoint> = Vec::new();
        for style in components.iter().filter_map(|c| c.style) {
            for &(name, width) in style.breakpoints {
                if !breakpoints.iter().any(|b| b.0 == name && same_width(b.1, width)) {
                    breakpoints.push((name, width, style.file));
                }
            }
        }
        // Each stylesheet: the sections that link it (none: `components.css`), its CSS and the
        // components in it.
        let mut sheets: Vec<(Vec<usize>, String, Vec<&'static str>)> = Vec::new();
        let mut events = String::new();
        let mut registered = std::collections::HashSet::new();
        // The scripts that import `corten/events`, so a page that loads one preloads it too.
        let mut imports_events = std::collections::HashSet::new();
        // The scripts that import `corten/views`, so a page the runtime swaps in preloads it with them.
        let mut imports_views = std::collections::HashSet::new();
        // The script modules each listed script imports from its directory, preloaded with it.
        let mut module_imports: HashMap<String, &'static [&'static str]> = HashMap::new();
        for (at, component) in listed {
            if let Some((same, first)) = seen.iter().find(|(c, _)| c.name == component.name) {
                let script = |c: &Component| c.script.map(|s| s.source);
                let style = |c: &Component| c.style.map(|s| s.css);
                let event = |c: &Component| c.event.map(|e| e.name);
                let view = |c: &Component| c.view.map(|v| v.js);
                if script(same) == script(component)
                    && style(same) == style(component)
                    && event(same) == event(component)
                    && view(same) == view(component)
                {
                    if *first != at && (*first == 0 || at == 0) && component.style.is_some() {
                        return Err(clash(format!(
                            "{} is listed in {} and in {}: App::components links its stylesheet from every page, so list it there only",
                            component.name,
                            place(*first),
                            place(at)
                        )));
                    }
                    continue;
                }
            }
            if let Some(script) = component.script {
                let url = format!("scripts/{}.js", script.name);
                if sources.iter().any(|(u, _)| *u == url) {
                    return Err(clash(format!(
                        "two scripts named {}: {url} is already there when adding {}'s {}",
                        script.name, component.name, script.file
                    )));
                }
                sources.push((url, crate::script::served(script.name, script.source).into_bytes().into()));
                registered.insert(script.name.to_string());
                if !script.events.is_empty() {
                    imports_events.insert(script.name.to_string());
                }
                if names(script.source.as_bytes(), "corten/views") {
                    imports_views.insert(script.name.to_string());
                }
                if !script.imports.is_empty() {
                    module_imports.insert(script.name.to_string(), script.imports);
                }
            }
            if let Some(event) = component.event {
                if let Some(other) =
                    seen.iter().filter_map(|(c, _)| c.event).find(|e| e.class == event.class || e.name == event.name)
                {
                    return Err(clash(format!(
                        "two events are {} ({:?}): `corten/events` has one class and the page one event of a name, so rename one",
                        if other.class == event.class { event.class } else { event.name },
                        [other.class, event.class]
                    )));
                }
                if events.is_empty() {
                    events.push_str(EVENT_CLASS);
                }
                events.push_str(&format!("export const {} = event({:?});\n", event.class, event.name));
            }
            if let Some(style) = component.style {
                if at > 0 && style.global() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "{} styles every page (custom properties, themes, utilities): list it in App::components, not in {}",
                            component.name,
                            place(at)
                        ),
                    ));
                }
                if let Some((other, _)) = seen.iter().find(|(c, _)| c.style.is_some_and(|s| s.name == style.name)) {
                    return Err(clash(format!(
                        "{} and {} both style .{}__*: two components named {} in different modules need different names",
                        other.name, component.name, style.name, component.name
                    )));
                }
                let linked = match listed_in.iter().find(|(name, _)| *name == component.name) {
                    Some((_, at)) if !at.is_empty() => {
                        let mut at = at.clone();
                        at.sort_unstable();
                        at
                    }
                    _ => Vec::new(),
                };
                let sheet = match sheets.iter().position(|(s, _, _)| *s == linked) {
                    Some(i) => &mut sheets[i],
                    None => {
                        sheets.push((linked, String::new(), Vec::new()));
                        sheets.last_mut().expect("just pushed")
                    }
                };
                if !sheet.1.is_empty() {
                    sheet.1.push('\n');
                }
                with_breakpoints(&mut sheet.1, component.name, &style, &breakpoints)?;
                sheet.2.push(component.name);
            }
            seen.push((component, at));
        }
        // The formatter a handler's format argument needs, for the pages whose handlers take one.
        if !registered.is_empty() {
            let name = crate::script::FORMAT_MODULE;
            let url = format!("scripts/{name}.js");
            if sources.iter().any(|(u, _)| *u == url) {
                return Err(clash(format!("the static directory has a {url}, the name of Corten's script formats")));
            }
            sources.push((url, crate::script::served(name, crate::script::FORMAT_JS).into_bytes().into()));
            registered.insert(name.to_string());
            // The upload module, for the pages with a form whose handlers hear its progress.
            let name = crate::script::UPLOAD_MODULE;
            let url = format!("scripts/{name}.js");
            if sources.iter().any(|(u, _)| *u == url) {
                return Err(clash(format!("the static directory has a {url}, the name of Corten's upload module")));
            }
            sources.push((url, crate::script::served(name, crate::script::UPLOAD_JS).into_bytes().into()));
            registered.insert(name.to_string());
        }
        // `corten/keys`, for the apps with a script that imports it: preloaded with that script (it
        // is one of its imports), so no page without one fetches it. Only a listed script brings
        // it, since only those are read when the crate compiles: a static script that imports it
        // alone would fail in the browser, so it is an error now.
        let keys_url = format!("scripts/{}.js", crate::script::KEYS_MODULE);
        if sources.iter().any(|(u, _)| *u == keys_url) {
            return Err(clash(format!("the static directory has a {keys_url}, the name of Corten's keys module")));
        }
        if module_imports.values().any(|imports| imports.contains(&crate::script::KEYS_MODULE)) {
            sources.push((keys_url, Bytes::from_static(crate::script::KEYS_JS.as_bytes())));
        } else if let Some((url, _)) = sources.iter().find(|(u, body)| {
            // The rule corten-macros applies to a listed script: any quoted or backticked name.
            u.ends_with(".js") && names(body, "corten/keys")
        }) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{url} imports corten/keys, which Corten serves only when a listed component or script! module imports it: move the shortcut's handler into one"),
            ));
        }
        // A static script a listed one imports (`scripts/helper.js`) is not read when the crate
        // compiles, so whether it imports the views is found here. It is read as written,
        // comments included: in an app with views, a commented-out import costs one needless
        // preload; in one without, it is refused below, as an import of `corten/keys` is.
        for (url, body) in &sources {
            let Some(name) = url.strip_prefix("scripts/").and_then(|n| n.strip_suffix(".js")) else { continue };
            if !registered.contains(name) && names(body, "corten/views") {
                imports_views.insert(name.to_string());
            }
        }
        if !events.is_empty() {
            if sources.iter().any(|(u, _)| u == EVENTS) {
                return Err(clash(format!("the static directory has an {EVENTS}, the name of the typed events' module")));
            }
            sources.push((EVENTS.to_string(), events.into_bytes().into()));
        }
        let all: Vec<Component> = seen.iter().map(|(c, _)| **c).collect();
        if let Some(views) = crate::script::views_module(&all).map_err(clash)? {
            if sources.iter().any(|(u, _)| u == VIEWS) {
                return Err(clash(format!("the static directory has a {VIEWS}, the name of the views' module")));
            }
            sources.push((VIEWS.to_string(), views.into_bytes().into()));
        } else if let Some(name) = imports_views.iter().min() {
            // `tsc` sees `rows()` and `view()` declared for every app (they ship with the crate),
            // but the import map names `corten/views` only for an app with a view, so the import
            // would fail in the browser.
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("scripts/{name}.js imports corten/views, which Corten serves only to an app that lists a #[component(view)]: list the view's component, or import nothing from corten/views"),
            ));
        }
        let styles: Vec<(&str, crate::Style)> = seen.iter().filter_map(|(c, _)| Some((c.name, c.style?))).collect();
        undeclared_properties(&sheets, &sources, &styles, sections)?;
        let css = sheets.iter().position(|(s, _, _)| s.is_empty()).map(|i| sheets.remove(i).1).unwrap_or_default();
        // Every page that draws a component's rule has the hidden rule: in `components.css`, or,
        // when only areas have stylesheets, in each of theirs.
        let hidden_in_sections = if css.is_empty() { HIDDEN_RULE } else { "" };
        if !css.is_empty() {
            if sources.iter().any(|(u, _)| u == STYLESHEET) {
                return Err(clash(format!("the static directory has a {STYLESHEET}, the name of the components' stylesheet")));
            }
            sources.push((STYLESHEET.to_string(), format!("{HIDDEN_RULE}{css}").into_bytes().into()));
        }
        // In the order the sections are listed, each section's own file before the files it shares.
        sheets.sort_by_key(|(at, _, _)| (at[0], at.len()));
        let mut section_files = Vec::new();
        for (at, css, components) in sheets {
            let prefixes: Vec<String> = at.iter().map(|i| sections[i - 1].0.to_string()).collect();
            let file = section_file(&prefixes);
            if sources.iter().any(|(u, _)| *u == file) {
                return Err(clash(format!("the static directory has a {file}, the name of a section's stylesheet")));
            }
            sources.push((file.clone(), format!("{hidden_in_sections}{css}").into_bytes().into()));
            section_files.push(Section { prefixes, href: file, components });
        }
        sources.sort_by(|a, b| a.0.cmp(&b.0));
        let mut files = HashMap::new();
        let mut digest = fnv::OFFSET;
        let scripts: std::collections::HashSet<String> = sources
            .iter()
            .filter_map(|(url, _)| url.strip_prefix("scripts/")?.strip_suffix(".js"))
            .filter(|name| !name.contains('/'))
            .map(str::to_string)
            .collect();
        // An import of a script the app does not serve would 404 in the browser: an error now.
        let mut importers: Vec<_> = module_imports.iter().collect();
        importers.sort_unstable_by_key(|(name, _)| name.as_str());
        for (name, imports) in importers {
            if let Some(missing) = imports.iter().find(|i| !scripts.contains(**i)) {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!(
                        "scripts/{name}.js imports ./{missing}.js, and no listed component or script! module is {missing}: list it where {name} is listed (App::components or the area's)"
                    ),
                ));
            }
        }
        for (url, body) in sources {
            let hash = fnv::hash(&body);
            digest = fnv::extend(digest, url.as_bytes());
            digest = fnv::extend(digest, &hash.to_le_bytes());
            let content_type = content_type(&url);
            #[cfg(feature = "compress")]
            let body = crate::compress::Precompressed::new(body, content_type);
            files.insert(url.clone(), File { body, content_type, hash });
        }
        let version = format!("{:012x}", digest >> 16);
        let prefix = format!("{mount}/{version}/");
        let stylesheet = files.contains_key(STYLESHEET).then(|| format!("{prefix}{STYLESHEET}"));
        let sections = section_files.into_iter().map(|s| Section { href: format!("{prefix}{}", s.href), ..s }).collect();
        let scripts_dir = format!("{prefix}scripts/");
        let mut module_tags: Vec<ModuleTag> = scripts
            .iter()
            .map(|name: &String| {
                let mut tag = if registered.contains(name) {
                    format!(r#"<script type="module" src="{scripts_dir}{name}.js"></script>"#)
                } else {
                    format!(r#"<link rel="modulepreload" href="{scripts_dir}{name}.js">"#)
                };
                // The modules it imports, and theirs, fetched with it rather than once it arrives.
                let mut imports: Vec<Box<str>> = Vec::new();
                let mut events = imports_events.contains(name);
                let mut views = imports_views.contains(name);
                let mut found: Vec<&str> = vec![name];
                let mut at = 0;
                while at < found.len() {
                    for &next in module_imports.get(found[at]).copied().unwrap_or_default() {
                        if !found.contains(&next) {
                            found.push(next);
                            let link = format!(r#"<link rel="modulepreload" href="{scripts_dir}{next}.js">"#);
                            tag.push_str(&link);
                            imports.push(link.into());
                            events |= imports_events.contains(next);
                            views |= imports_views.contains(next);
                        }
                    }
                    at += 1;
                }
                ModuleTag {
                    name: name.as_str().into(),
                    tag: tag.into(),
                    imports: imports.into(),
                    imports_events: events,
                    imports_views: views,
                }
            })
            .collect();
        module_tags.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        let views_tag = files.contains_key(VIEWS).then(|| format!(r#"<link rel="modulepreload" href="{prefix}{VIEWS}">"#).into());
        let events_tag =
            files.contains_key(EVENTS).then(|| format!(r#"<link rel="modulepreload" href="{prefix}{EVENTS}">"#).into());
        Ok(Assets {
            module_tags: module_tags.into(),
            views_tag,
            events_tag,
            scripts_dir,
            mount: mount.into(),
            version,
            prefix,
            files,
            scripts,
            registered,
            stylesheet,
            sections,
            owner: None,
        })
    }

    /// Each section stylesheet, in the order the sections are listed.
    pub(crate) fn section_stylesheets(&self) -> &[Section] {
        &self.sections
    }

    /// Whether the app has a stylesheet of any kind: its components', an area's, or a `.css` file
    /// among its static files.
    #[cfg(debug_assertions)]
    pub(crate) fn styled(&self) -> bool {
        self.stylesheet.is_some() || !self.sections.is_empty() || self.files.keys().any(|path| path.ends_with(".css"))
    }

    /// The URL of the components' joined stylesheet, when a listed component has one.
    pub fn stylesheet(&self) -> Option<&str> {
        self.stylesheet.as_deref()
    }

    /// The URL of `file`. One of another app's directory is a bug, found in debug builds.
    pub fn asset(&self, file: Asset) -> AssetUrl<'_> {
        debug_assert!(
            self.owner == Some(file.owner),
            "corten: {} is a file of {}, and this app's static directory is {} (App::assets)",
            file.path,
            file.owner,
            self.owner.unwrap_or("none")
        );
        AssetUrl { prefix: &self.prefix, path: file.path }
    }

    /// The URL of the file at `path` (`cards/item_1.svg`), a name from data, when there is one.
    pub fn find<'a>(&'a self, path: &'a str) -> Option<AssetUrl<'a>> {
        self.files.contains_key(path).then_some(AssetUrl { prefix: &self.prefix, path })
    }

    /// The URL for `path` (relative to the directory, like `style.css`), which must be there.
    #[cfg(test)]
    pub(crate) fn url(&self, path: &str) -> String {
        assert!(self.files.contains_key(path), "no static file {path:?}");
        format!("{}{path}", self.prefix)
    }

    /// True when the directory has `path` (relative, like `style.css`).
    pub fn contains(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    /// `{mount}/{version}/`.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// `{mount}/`, the prefix every version shares.
    pub fn mount_prefix(&self) -> String {
        format!("{}/", self.mount)
    }

    /// True when there is a script module `name` (a component's or a `script!` module, or a
    /// file in `scripts/`).
    pub fn has_script(&self, name: &str) -> bool {
        self.scripts.contains(name)
    }

    /// True when the script module `name` hands its exports to the runtime as it runs (a component's or
    /// a `script!` module): a page loads it with `<script type="module">`, not an `import()`.
    pub fn registers(&self, name: &str) -> bool {
        self.registered.contains(name)
    }

    /// The tag that loads the script module `name` with a page, when there is one. Debug builds
    /// only: the check that a page's handlers call a module the app serves.
    #[cfg(debug_assertions)]
    pub(crate) fn module_tag(&self, name: &str) -> Option<&str> {
        self.module(name).map(|(tag, ..)| tag)
    }

    /// The tag that loads the script module `name`, and whether it (or a module it imports)
    /// imports the typed events and the views.
    pub(crate) fn module(&self, name: &str) -> Option<(&str, bool, bool)> {
        let at = self.module_tags.binary_search_by(|m| (*m.name).cmp(name)).ok()?;
        let module = &self.module_tags[at];
        Some((&module.tag, module.imports_events, module.imports_views))
    }

    /// What a page the runtime swaps in carries for the script module `name`: the preload tag of
    /// each module it imports, and whether it imports the typed events and the views.
    pub(crate) fn swap_imports(&self, name: &str) -> Option<(&[Box<str>], bool, bool)> {
        let at = self.module_tags.binary_search_by(|m| (*m.name).cmp(name)).ok()?;
        let module = &self.module_tags[at];
        Some((&module.imports, module.imports_events, module.imports_views))
    }

    /// The typed events' module preload tag, when a listed script imports any `#[event]`.
    pub(crate) fn events_tag(&self) -> Option<&str> {
        self.events_tag.as_deref()
    }

    /// The views' module preload tag, when the app lists any `#[component(view)]`.
    pub(crate) fn views_tag(&self) -> Option<&str> {
        self.views_tag.as_deref()
    }

    /// Where script modules are served from: `{prefix}scripts/`.
    pub fn scripts_dir(&self) -> &str {
        &self.scripts_dir
    }

    /// The URL of the typed events' module, when a listed script imports any `#[event]`.
    pub fn events(&self) -> Option<String> {
        self.files.contains_key(EVENTS).then(|| format!("{}{EVENTS}", self.prefix))
    }

    /// The URL of `corten/keys`, when a script of the app imports it.
    pub fn keys(&self) -> Option<String> {
        let file = format!("scripts/{}.js", crate::script::KEYS_MODULE);
        self.files.contains_key(&file).then(|| format!("{}{file}", self.prefix))
    }

    /// The URL of the views' module, when the app lists any `#[component(view)]`.
    pub fn views(&self) -> Option<String> {
        self.files.contains_key(VIEWS).then(|| format!("{}{VIEWS}", self.prefix))
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    /// Every file's URL, for a service worker precache list.
    pub fn urls(&self) -> impl Iterator<Item = String> + '_ {
        self.files.keys().map(|path| format!("{}{path}", self.prefix))
    }

    /// The route that serves the files. Merge into the app router.
    pub fn routes<S: Clone + Send + Sync + 'static>(self: &Arc<Self>) -> Router<S> {
        let assets = self.clone();
        Router::new().route(
            &format!("{}/{{version}}/{{*path}}", self.mount),
            get(move |UrlPath((version, path)): UrlPath<(String, String)>, method: Method, headers: HeaderMap| {
                let assets = assets.clone();
                async move {
                    let (cache, url) = if version == assets.version {
                        (IMMUTABLE, Url::Current)
                    } else {
                        (HeaderValue::from_static("no-cache"), Url::Old)
                    };
                    assets.serve(&path, &method, &headers, cache, url)
                }
            }),
        )
    }

    /// The file at `path`, asked for at a URL of the kind `url`.
    fn serve(&self, path: &str, method: &Method, headers: &HeaderMap, cache: HeaderValue, url: Url) -> Response {
        let Some(file) = self.files.get(path) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        #[cfg(feature = "compress")]
        let (body, coding) = file.body.pick(headers);
        #[cfg(not(feature = "compress"))]
        let body = file.body.clone();
        let etag = if url == Url::Fixed {
            // Its URL is revalidated: keep the same weak content tag while background
            // compression changes the encoded bytes. Versioned files keep per-coding tags.
            HeaderValue::try_from(format!("W/\"{:016x}\"", file.hash)).expect("hex tag")
        } else {
            #[cfg(feature = "compress")]
            {
                etag(file.hash, coding.map(|c| c.tag()))
            }
            #[cfg(not(feature = "compress"))]
            {
                etag(file.hash, None)
            }
        };
        // Compared weakly, as RFC 9110 has `If-None-Match` compared: a proxy that marks the tag
        // weak (`W/`), a list of tags or `*` still gets the 304.
        let opaque = etag.as_bytes().strip_prefix(b"W/").unwrap_or(etag.as_bytes());
        if headers.get_all(header::IF_NONE_MATCH).iter().any(|line| crate::cache::names(line.as_bytes(), opaque)) {
            #[allow(unused_mut)]
            let mut res = (StatusCode::NOT_MODIFIED, [(header::ETAG, etag), (header::CACHE_CONTROL, cache)]).into_response();
            #[cfg(feature = "compress")]
            crate::compress::encoded_headers(res.headers_mut(), file.content_type, None);
            return res;
        }
        // A range of the file as it is stored, to a GET sent it unencoded (a video seeking): an
        // encoded body's offsets are not the file's, so it is sent whole, and RFC 9110 has every other
        // method ignore `Range`. Only a URL of this version names these exact bytes: an old
        // version's URL or the favicon's may name other bytes across a deploy, and a player that
        // joined ranges of two would play neither, so those are sent whole. `If-Range` holds for
        // this version's own strong tag only (the files have no date). No `Accept-Ranges`: a
        // browser asks for a range unprompted, and the header would cost every file's answer (#1133).
        #[cfg(feature = "compress")]
        let ranged = url == Url::Current && coding.is_none() && method == Method::GET;
        #[cfg(not(feature = "compress"))]
        let ranged = url == Url::Current && method == Method::GET;
        let range = match ranged.then(|| headers.get(header::RANGE)).flatten() {
            Some(value) => {
                let strong = !etag.as_bytes().starts_with(b"W/");
                let holds = headers.get(header::IF_RANGE).is_none_or(|tag| strong && *tag == etag);
                holds.then(|| byte_range(value.as_bytes(), body.len())).flatten()
            }
            None => None,
        };
        let head = [
            (header::CONTENT_TYPE, HeaderValue::from_static(file.content_type)),
            (header::CACHE_CONTROL, cache),
            (header::ETAG, etag),
        ];
        #[allow(unused_mut)]
        let mut res = match range {
            None => (head, body).into_response(),
            Some(Ok(range)) => {
                let at = format!("bytes {}-{}/{}", range.start, range.end - 1, body.len());
                let mut res = (StatusCode::PARTIAL_CONTENT, head, body.slice(range)).into_response();
                res.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::try_from(at).expect("digits"));
                res
            }
            Some(Err(())) => return unsatisfiable(body.len()),
        };
        #[cfg(feature = "compress")]
        crate::compress::encoded_headers(res.headers_mut(), file.content_type, coding);
        res
    }
}

/// What a URL a file is asked for at names, which decides its tag and whether it is sent in part.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Url {
    /// This version's URL: these exact bytes, under a strong tag, sent in ranges.
    Current,
    /// An older version's URL: maybe other bytes after a deploy, so sent whole.
    Old,
    /// A URL that outlives a deploy (the favicon's): revalidated under a weak tag, sent whole.
    Fixed,
}

/// The one byte range a `Range` header asks of a body `len` bytes long (RFC 9110 14.1.2):
/// `Some(Ok(range))` to send, `Some(Err(()))` when it starts past the end (a 416), and `None` to
/// send the whole body, as a server may for a header it does not parse, another unit or several
/// ranges.
fn byte_range(value: &[u8], len: usize) -> Option<Result<std::ops::Range<usize>, ()>> {
    let (unit, set) = std::str::from_utf8(value).ok()?.split_once('=')?;
    if !unit.trim_ascii().eq_ignore_ascii_case("bytes") || set.contains(',') {
        return None;
    }
    let (first, last) = set.trim_ascii().split_once('-')?;
    let number = |digits: &str| digits.bytes().all(|b| b.is_ascii_digit()).then(|| digits.parse::<u64>().ok()).flatten();
    let len64 = len as u64;
    let (start, end) = if first.is_empty() {
        // The last `n` bytes; none at all cannot be sent, and of an empty body they are the whole
        // (empty) body (RFC 9110 14.1.1).
        let n = number(last)?;
        if n == 0 {
            return Some(Err(()));
        }
        if len == 0 {
            return None;
        }
        (len64.saturating_sub(n), len64)
    } else {
        let start = number(first)?;
        let end = match last {
            "" => len64,
            last => number(last).filter(|&last| last >= start)?.saturating_add(1).min(len64),
        };
        if start >= len64 {
            return Some(Err(()));
        }
        (start, end)
    };
    Some(Ok(start as usize..end as usize))
}

/// The 416 for a range past the end of a body `len` bytes long, naming its length: sent as it is,
/// not as the app's error page, which would drop `Content-Range`.
fn unsatisfiable(len: usize) -> Response {
    let whole = HeaderValue::try_from(format!("bytes */{len}")).expect("digits");
    let mut res = (StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, whole)]).into_response();
    res.extensions_mut().insert(crate::page::AsIs);
    res
}

/// A file's ETag: its hash in hex, quoted, and its coding's tag after a `-` (`"0123..ef-br"`).
fn etag(hash: u64, coding: Option<&str>) -> HeaderValue {
    let mut tag = String::with_capacity(24);
    tag.push('"');
    tag.push_str(crate::ascii::hex(hash, &mut [0; 16]));
    if let Some(coding) = coding {
        tag.push('-');
        tag.push_str(coding);
    }
    tag.push('"');
    HeaderValue::try_from(tag).expect("hex is a valid header")
}

/// A stylesheet of components only some sections list (`Area::components`).
#[derive(Clone, Debug)]
pub(crate) struct Section {
    /// The prefixes of the sections that list them: pages at or under one link it.
    pub prefixes: Vec<String>,
    /// Its URL.
    pub href: String,
    /// The components whose rules it has.
    pub components: Vec<&'static str>,
}

/// A token file's breakpoint: its name, its width (`48rem`) and the file that makes it.
type Breakpoint = (&'static str, &'static str, &'static str);

/// Whether two widths a token file writes are one width to a browser: the same unit (the trailing
/// letters) and the same number, so `40rem`, `40.0rem` and `4e1rem` agree, as `corten ui add`
/// reads them.
fn same_width(a: &str, b: &str) -> bool {
    fn split(w: &str) -> (Option<f64>, &str) {
        let at = w.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '%').len();
        (w[..at].parse::<f64>().ok(), &w[at..])
    }
    match (split(a), split(b)) {
        ((Some(x), unit), (Some(y), other)) => x == y && unit == other,
        _ => a == b,
    }
}

/// Appends a component's CSS with each breakpoint its `@media` rules name (`(--md)`, a custom media
/// query, which browsers do not read) written as the width the token file gives it,
/// `(min-width:48rem)`, as its utilities' `md:` classes use. The component is compiled without the
/// app's token file (a kit's in a crate several apps share), so this is where the two meet; an
/// unknown name stops the app, as an unknown `var()` does.
fn with_breakpoints(out: &mut String, component: &str, style: &crate::Style, breakpoints: &[Breakpoint]) -> io::Result<()> {
    let mut copied = 0;
    for &(at, name) in style.media {
        debug_assert!(style.css[at..].starts_with(&format!("(--{name})")), "{}: (--{name}) at {at}", style.file);
        let widths: Vec<&Breakpoint> = breakpoints.iter().filter(|b| b.0 == name).collect();
        let [(_, width, _)] = widths[..] else {
            if widths.len() > 1 {
                let each: Vec<String> = widths.iter().map(|(_, width, file)| format!("{file} {width}")).collect();
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                    "{} ({component}) names the breakpoint --{name} in an @media rule, and the token files in App::components give it different widths ({}): make it one width, or remove it from all but one",
                    style.file,
                    each.join(", ")
                    ),
                ));
            }
            // Each with its width, so the line that adds it can name the one it should be. One that
            // names another (`"phone": "{sm}"`) has that one's width, after it in its file: it is
            // left out, since naming it would make a chain.
            let mut made: Vec<(&str, &str, &str)> = Vec::new();
            for (n, width, file) in breakpoints {
                if !made.iter().any(|(m, w, f)| m == n || (w == width && f == file)) {
                    made.push((n, width, file));
                }
            }
            let message = match made.first() {
                None => format!(
                    "{} ({component}) names the breakpoint --{name} in an @media rule, and no token file in App::components makes one: add a token file that makes {name} ($extensions.\"run.corten\".breakpoints)",
                    style.file
                ),
                Some((first, _, _)) => format!(
                    "{} ({component}) names the breakpoint --{name} in an @media rule, and the token files in App::components make {}: add {name} to $extensions.\"run.corten\".breakpoints in one of them, as a width none of them has (smallest first), or as the name of one it makes in braces (\"{name}\": \"{{{first}}}\"), which one at a width it already has must be; or name one they make",
                    style.file,
                    made.iter().map(|(n, width, _)| format!("{n} ({width})")).collect::<Vec<_>>().join(", "),
                ),
            };
            return Err(io::Error::new(io::ErrorKind::NotFound, message));
        };
        out.push_str(&style.css[copied..at]);
        out.push_str("(min-width:");
        out.push_str(width);
        out.push(')');
        copied = at + name.len() + 4;
    }
    out.push_str(&style.css[copied..]);
    Ok(())
}

/// Each `var(--x)` with no fallback in a component's stylesheet (or the token file's) must name
/// a custom property a stylesheet on the same pages declares: the token file's, a component's in
/// `components.css`, a `.css` file in the static directory, or, for an area's component, one in
/// a stylesheet linked from every one of its areas. Otherwise the value is invalid and the
/// property inherits, which shows only as a wrong color in a browser. Checked here because a
/// component's stylesheet is compiled without the theme; this runs once, at startup.
fn undeclared_properties(
    sheets: &[(Vec<usize>, String, Vec<&'static str>)],
    sources: &[(String, Bytes)],
    styles: &[(&str, crate::Style)],
    sections: &[(&str, &[Component])],
) -> io::Result<()> {
    use std::collections::HashSet;
    let declared = |css: &str, into: &mut HashSet<String>| {
        into.extend(crate::style::custom_properties(css).0.into_iter().map(str::to_string));
    };
    let mut everywhere = HashSet::new();
    for (_, body) in sources.iter().filter(|(url, _)| url.ends_with(".css")) {
        // A file that is not text declares nothing.
        if let Ok(css) = std::str::from_utf8(body) {
            declared(css, &mut everywhere);
        }
    }
    for (_, css, _) in sheets.iter().filter(|(at, _, _)| at.is_empty()) {
        declared(css, &mut everywhere);
    }
    // What each area's pages add: the section stylesheets linked from them, its own and those of
    // the areas it is under (`/admin`'s on `/admin/reports`'s pages).
    let in_area: Vec<HashSet<String>> = (1..=sections.len())
        .map(|i| {
            let mut set = HashSet::new();
            let linked = |j: &usize| crate::api::under(sections[j - 1].0, sections[i - 1].0);
            for (_, css, _) in sheets.iter().filter(|(at, _, _)| at.iter().any(linked)) {
                declared(css, &mut set);
            }
            set
        })
        .collect();
    let mut missing = Vec::new();
    for (at, _, names) in sheets {
        for (name, style) in names.iter().filter_map(|n| styles.iter().find(|(s, _)| s == n)) {
            for property in crate::style::custom_properties(style.css).1 {
                if everywhere.contains(property) {
                    continue;
                }
                let lacking: Vec<&str> =
                    at.iter().filter(|i| !in_area[**i - 1].contains(property)).map(|i| sections[i - 1].0).collect();
                let line = if at.is_empty() {
                    format!("{} ({name}) reads var({property}), which no stylesheet declares", style.file)
                } else if !lacking.is_empty() {
                    format!(
                        "{} ({name}) reads var({property}), which no stylesheet on the pages of {} declares",
                        style.file,
                        lacking.join(", ")
                    )
                } else {
                    continue;
                };
                if !missing.contains(&line) {
                    missing.push(line);
                }
            }
        }
    }
    if missing.is_empty() {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "{}. A custom property comes from tokens!, a component's stylesheet or a .css file in the static directory: fix the name, declare it, or give the var() a fallback (var(--x, ..)) when a script sets it",
            missing.join("; ")
        ),
    ))
}

/// Whether a script's source names `module` quoted or backticked (`"corten/views"`): the rule
/// corten-macros applies to a listed script's imports, so a dynamic `import()` counts too.
/// Corten-macros strips a listed script's comments first; a static file is read as written.
fn names(body: &[u8], module: &str) -> bool {
    let len = module.len() + 2;
    body.windows(len).any(|w| {
        matches!((w[0], w[len - 1]), (b'"', b'"') | (b'\'', b'\'') | (b'`', b'`')) && &w[1..len - 1] == module.as_bytes()
    })
}

/// Where a section's stylesheet is served: `sections/admin.css` for `/admin`, and
/// `sections/search+categories.css` for the components `/search` and `/categories` share.
fn section_file(prefixes: &[String]) -> String {
    let names: Vec<&str> = prefixes.iter().map(|p| p.trim_start_matches('/')).collect();
    format!("sections/{}.css", names.join("+"))
}

/// Every file under `dir`, by its path there (`icons/192.png`): for `corten dev`, which reads the
/// directory an [`embed!`] read, so a file added since the build is served.
pub(crate) fn read_dir(dir: &Path) -> io::Result<Vec<(String, Bytes)>> {
    let mut paths = Vec::new();
    collect(dir, dir, &mut paths)?;
    let mut files = Vec::with_capacity(paths.len());
    for (url, path) in paths {
        files.push((url, Bytes::from(std::fs::read(&path)?)));
    }
    Ok(files)
}

/// The files [`embed!`] compiled in, with no copy.
pub(crate) fn embedded<E: Embed>() -> Vec<(String, Bytes)> {
    E::FILES.iter().map(|(path, body)| ((*path).to_string(), Bytes::from_static(body))).collect()
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        // Dotfiles (.env, .DS_Store, editor swap files) are never public.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect(root, &path, out)?;
        } else if kind.is_symlink() && path.is_dir() {
            // `embed!` refuses a linked directory, so one added under `corten dev` is not served.
            continue;
        } else {
            let relative = path.strip_prefix(root).expect("walked from root");
            let url = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            out.push((url, path));
        }
    }
    Ok(())
}

pub(crate) fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).as_deref() {
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("wasm") => "application/wasm",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("vtt") => "text/vtt; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("xml") => "application/xml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::Scratch;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    /// A file's tag is its hash in 16 hex digits, quoted, with each coding's tag after a `-`.
    #[test]
    fn an_etag_is_the_hash_in_hex_and_the_coding() {
        for hash in [0, 0xab, 0x0123_4567_89ab_cdef, u64::MAX] {
            assert_eq!(etag(hash, None), format!("\"{hash:016x}\"").as_str());
            for coding in ["zst", "br", "gz"] {
                assert_eq!(etag(hash, Some(coding)), format!("\"{hash:016x}-{coding}\"").as_str());
            }
        }
    }

    fn dir(name: &str, files: &[(&str, &str)]) -> Scratch {
        let root = Scratch::new(&format!("assets-{name}"));
        for (path, body) in files {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        root
    }

    /// What serving a file costs: `ASSET_REQUESTS` (200) requests of a 4 KiB stylesheet in process,
    /// one at a time, unencoded (the answer a range is read for). Counted under callgrind at two
    /// numbers of requests (200 and 1,200), the difference over the 1,000 requests between them is
    /// the instructions a request:
    /// `ASSET_REQUESTS=200 cargo test --release -p corten-run --all-features --lib -- --ignored what_serving_a_file_costs`,
    /// then the same with `ASSET_REQUESTS=1200`.
    #[test]
    #[ignore]
    fn what_serving_a_file_costs() {
        let requests: usize = std::env::var("ASSET_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let root = dir("cost", &[("style.css", &"a{color:red}\n".repeat(320))]);
        let assets = Arc::new(Assets::load(&root, "/assets").unwrap());
        let app: Router = assets.routes();
        let url = assets.url("style.css");
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(async {
            for _ in 0..requests {
                let res = app.clone().oneshot(Request::get(&url).body(Body::empty()).unwrap()).await.unwrap();
                assert_eq!(res.status(), StatusCode::OK);
            }
        });
    }

    #[tokio::test]
    async fn versioned_urls_are_immutable_and_old_versions_are_not_cached() {
        let root = dir("serve", &[("style.css", "a{}"), ("scripts/x_y.js", "export function f() {}"), (".env", "SECRET=1")]);
        let assets = Arc::new(Assets::load(&root, "/assets").unwrap());
        assert_eq!(assets.scripts_dir(), format!("/assets/{}/scripts/", assets.version()));
        let app: Router = assets.routes();
        let get = |uri: String| app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap());
        let res = get(assets.url("style.css")).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["cache-control"], "public, max-age=31536000, immutable");
        assert_eq!(res.headers()["content-type"], "text/css; charset=utf-8");
        let res = get(format!("/assets/{}/scripts/x_y.js", assets.version())).await.unwrap();
        assert_eq!(res.headers()["content-type"], "text/javascript; charset=utf-8");
        let res = get("/assets/000000000000/style.css".into()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["cache-control"], "no-cache");
        assert_eq!(get(assets.url("style.css").replace("style", "nope")).await.unwrap().status(), StatusCode::NOT_FOUND);
        let traversal = format!("/assets/{}/../Cargo.toml", assets.version());
        assert_eq!(get(traversal).await.unwrap().status(), StatusCode::NOT_FOUND, "only loaded files are served");
        let dotfile = format!("/assets/{}/.env", assets.version());
        assert_eq!(get(dotfile).await.unwrap().status(), StatusCode::NOT_FOUND, "dotfiles are skipped");
    }

    /// Video and captions are named by their standard types (#1133).
    #[test]
    fn video_and_captions_have_their_types() {
        assert_eq!(content_type("intro.mp4"), "video/mp4");
        assert_eq!(content_type("intro.WEBM"), "video/webm");
        assert_eq!(content_type("captions/en.vtt"), "text/vtt; charset=utf-8");
    }

    /// One range of bytes, as RFC 9110 writes it; a range past the end is unsatisfiable, and what
    /// is not one range of bytes is ignored, so the whole body is sent.
    #[test]
    fn a_range_is_one_span_of_bytes() {
        let at = |value: &str| byte_range(value.as_bytes(), 100);
        assert_eq!(at("bytes=0-9"), Some(Ok(0..10)));
        assert_eq!(at("bytes=10-"), Some(Ok(10..100)));
        assert_eq!(at("bytes=90-500"), Some(Ok(90..100)), "a last byte past the end is the end");
        assert_eq!(at("bytes=-5"), Some(Ok(95..100)));
        assert_eq!(at("bytes=-500"), Some(Ok(0..100)));
        assert_eq!(at("Bytes = 0-0"), Some(Ok(0..1)), "the unit is compared without case");
        assert_eq!(at("bytes=100-"), Some(Err(())));
        assert_eq!(at("bytes=-0"), Some(Err(())));
        assert_eq!(byte_range(b"bytes=-1", 0), None, "of an empty body, the last bytes are all of it");
        for ignored in ["bytes=9-0", "bytes=0-1,5-6", "items=0-1", "bytes=+1-2", "bytes=a-", "bytes", "bytes=-"] {
            assert_eq!(at(ignored), None, "{ignored}");
        }
    }

    /// A video seeks: a range of a file is sent as a 206 of those bytes, named by `Content-Range`,
    /// a range past its end as a 416 naming its length, a range under another version's tag
    /// (`If-Range`) as the whole file, a file the client already has as a 304, and a `HEAD` whole
    /// (#1133).
    #[tokio::test]
    async fn a_file_is_sent_in_the_ranges_asked_for() {
        let video: String = (0..100u8).map(|i| char::from(b'a' + i % 26)).collect();
        let root = dir("ranges", &[("intro.mp4", &video)]);
        let assets = Arc::new(Assets::load(&root, "/assets").unwrap());
        let app: Router = assets.routes();
        let url = assets.url("intro.mp4");
        let get = |headers: &[(header::HeaderName, &str)]| {
            let mut req = Request::get(&url);
            for (name, value) in headers {
                req = req.header(name, *value);
            }
            app.clone().oneshot(req.body(Body::empty()).unwrap())
        };
        let body = |res: Response| async move { http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes() };
        let whole = get(&[]).await.unwrap();
        assert_eq!(whole.status(), StatusCode::OK);
        assert!(!whole.headers().contains_key(header::ACCEPT_RANGES), "a range is answered, not advertised");
        assert_eq!(whole.headers()[header::CONTENT_TYPE], "video/mp4");
        let tag = whole.headers()[header::ETAG].clone();
        let part = get(&[(header::RANGE, "bytes=10-19")]).await.unwrap();
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(
            (&part.headers()[header::ETAG], &part.headers()[header::CONTENT_TYPE]),
            (&tag, &HeaderValue::from_static("video/mp4"))
        );
        assert_eq!(body(part).await, video.as_bytes()[10..20]);
        let tail = get(&[(header::RANGE, "bytes=-5"), (header::IF_RANGE, tag.to_str().unwrap())]).await.unwrap();
        assert_eq!(
            (tail.status(), &tail.headers()[header::CONTENT_RANGE]),
            (StatusCode::PARTIAL_CONTENT, &HeaderValue::from_static("bytes 95-99/100"))
        );
        assert_eq!(body(tail).await, video.as_bytes()[95..]);
        let past = get(&[(header::RANGE, "bytes=100-")]).await.unwrap();
        assert_eq!(
            (past.status(), &past.headers()[header::CONTENT_RANGE]),
            (StatusCode::RANGE_NOT_SATISFIABLE, &HeaderValue::from_static("bytes */100"))
        );
        let stale = get(&[(header::RANGE, "bytes=10-19"), (header::IF_RANGE, "\"0000000000000000\"")]).await.unwrap();
        assert_eq!(stale.status(), StatusCode::OK, "another version's range is sent whole");
        assert_eq!(body(stale).await.len(), 100);
        let weak = format!("W/{}", tag.to_str().unwrap());
        let weak = get(&[(header::RANGE, "bytes=10-19"), (header::IF_RANGE, &weak)]).await.unwrap();
        assert_eq!(
            weak.status(),
            StatusCode::OK,
            "If-Range compares strongly: the weak tag a compressed copy carries is not this file"
        );
        let dated = get(&[(header::RANGE, "bytes=10-19"), (header::IF_RANGE, "Sun, 08 Nov 2026 00:00:00 GMT")]).await.unwrap();
        assert_eq!(dated.status(), StatusCode::OK, "the files have no date to compare");
        let huge = get(&[(header::RANGE, "bytes=99999999999999999999-")]).await.unwrap();
        assert_eq!(huge.status(), StatusCode::OK, "a number past u64 is not parsed, so the whole file is sent");
        let old = url.replacen(assets.version(), "000000000000", 1);
        let old = app
            .clone()
            .oneshot(Request::get(&old).header(header::RANGE, "bytes=10-19").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(old.status(), StatusCode::OK, "an old version's URL may name other bytes, so it is sent whole");
        assert_eq!(body(old).await.len(), 100);
        let kept = get(&[(header::RANGE, "bytes=10-19"), (header::IF_NONE_MATCH, tag.to_str().unwrap())]).await.unwrap();
        assert_eq!(kept.status(), StatusCode::NOT_MODIFIED);
        let head = app
            .clone()
            .oneshot(Request::head(&url).header(header::RANGE, "bytes=0-9").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK, "only a GET is answered in part (RFC 9110 14.2)");
        assert!(!head.headers().contains_key(header::CONTENT_RANGE));
        let root = dir("ranges-empty", &[("empty.vtt", "")]);
        let empty = Arc::new(Assets::load(&root, "/assets").unwrap());
        let res = empty
            .routes::<()>()
            .oneshot(Request::get(empty.url("empty.vtt")).header(header::RANGE, "bytes=0-").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            (res.status(), &res.headers()[header::CONTENT_RANGE]),
            (StatusCode::RANGE_NOT_SATISFIABLE, &HeaderValue::from_static("bytes */0")),
            "no byte of an empty file can be sent"
        );
    }

    /// Captions compressed for the client are sent whole: an encoded body's offsets are not the
    /// file's. A client that takes them unencoded gets its range.
    #[cfg(feature = "compress")]
    #[tokio::test]
    async fn an_encoded_file_is_sent_whole() {
        let captions = format!("WEBVTT\n\n{}", "00:00.000 --> 00:01.000\nA line of captions.\n\n".repeat(60));
        let root = dir("ranges-encoded", &[("en.vtt", &captions)]);
        let assets = Arc::new(Assets::load(&root, "/assets").unwrap());
        let app: Router = assets.routes();
        let url = assets.url("en.vtt");
        let get = |encodings: &str| {
            let req = Request::get(&url).header(header::RANGE, "bytes=0-9").header(header::ACCEPT_ENCODING, encodings);
            app.clone().oneshot(req.body(Body::empty()).unwrap())
        };
        let cold = get("br").await.unwrap();
        assert_eq!(cold.status(), StatusCode::PARTIAL_CONTENT, "before its compressed forms exist, the file is sent as stored");
        assert!(!cold.headers().contains_key(header::CONTENT_ENCODING));
        assets.files["en.vtt"].body.wait();
        let encoded = get("br").await.unwrap();
        assert_eq!(
            (encoded.status(), &encoded.headers()[header::CONTENT_ENCODING]),
            (StatusCode::OK, &HeaderValue::from_static("br"))
        );
        assert!(!encoded.headers().contains_key(header::ACCEPT_RANGES) && !encoded.headers().contains_key(header::CONTENT_RANGE));
        let plain = get("identity").await.unwrap();
        assert_eq!(
            (plain.status(), &plain.headers()[header::CONTENT_TYPE]),
            (StatusCode::PARTIAL_CONTENT, &HeaderValue::from_static("text/vtt; charset=utf-8"))
        );
        assert_eq!(
            plain.headers()[header::VARY],
            "accept-encoding",
            "a shared cache keeps the 206 from a client that takes brotli"
        );
    }

    /// Through the compression middleware, a range of a compressible file sent as it is stored
    /// (before its compressed forms exist, or to a client that takes only zstd) stays the exact
    /// bytes asked for: the middleware never encodes an answer that has a `Content-Range`.
    #[cfg(feature = "compress")]
    #[tokio::test]
    async fn the_middleware_leaves_a_range_as_it_is() {
        let captions = format!("WEBVTT\n\n{}", "00:00.000 --> 00:01.000\nA line of captions.\n\n".repeat(60));
        let root = dir("ranges-middleware", &[("en.vtt", &captions)]);
        let assets = Arc::new(Assets::load(&root, "/assets").unwrap());
        let app: Router = crate::compress::apply(assets.routes());
        let url = assets.url("en.vtt");
        for encodings in ["gzip", "zstd"] {
            let req = Request::get(&url).header(header::RANGE, "bytes=100-1299").header(header::ACCEPT_ENCODING, encodings);
            let res = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT, "{encodings}");
            assert!(!res.headers().contains_key(header::CONTENT_ENCODING), "{encodings}: a range is never encoded");
            let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
            assert_eq!(body, captions.as_bytes()[100..1300], "{encodings}: a slice large enough to compress");
        }
    }

    /// The fixed icon's content is unchanged when its background-compressed form becomes ready.
    #[cfg(feature = "compress")]
    #[tokio::test]
    async fn the_favicon_tag_survives_background_compression() {
        let svg = format!("<svg>{}</svg>", "<path d=\"M0 0h1v1\"/>".repeat(200));
        let root = dir("favicon-compression", &[("favicon.svg", &svg)]);
        let assets = Arc::new(Assets::load(&root, "/assets").unwrap());
        let app: Router = crate::compress::apply(favicon(Some(&assets)));
        let request = |tag: Option<HeaderValue>| {
            let mut req = Request::get(FAVICON_PATH).header(header::ACCEPT_ENCODING, "gzip, deflate");
            if let Some(tag) = tag {
                req = req.header(header::IF_NONE_MATCH, tag);
            }
            app.clone().oneshot(req.body(Body::empty()).unwrap())
        };
        let cold = request(None).await.unwrap();
        assert_eq!(cold.status(), StatusCode::OK);
        assert_eq!(cold.headers()[header::CONTENT_ENCODING], "gzip");
        let tag = cold.headers()[header::ETAG].clone();
        assert!(tag.to_str().unwrap().starts_with("W/\""));
        assets.files["favicon.svg"].body.wait();
        let again = request(Some(tag.clone())).await.unwrap();
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(again.headers()[header::ETAG], tag);
        assert_eq!(again.headers()[header::VARY], "accept-encoding");
        assert!(axum::body::to_bytes(again.into_body(), usize::MAX).await.unwrap().is_empty());
        let warm = request(None).await.unwrap();
        assert_eq!(warm.status(), StatusCode::OK);
        assert_eq!(warm.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(warm.headers()[header::ETAG], tag);
        let changed = request(Some(HeaderValue::from_static("W/\"another-icon\""))).await.unwrap();
        assert_eq!(changed.status(), StatusCode::OK);
    }

    const SCRIPT: Component = Component {
        name: "XY",
        script: Some(crate::Script {
            name: "x_y",
            file: "x_y.js",
            source: "export function f() {}",
            handlers: &["f"],
            events: &[],
            imports: &[],
        }),
        style: None,
        event: None,
        view: None,
        anchor: &0,
    };

    const fn styled(name: &'static str, prefix: &'static str, css: &'static str) -> Component {
        Component {
            name,
            script: None,
            style: Some(crate::Style { name: prefix, file: "x.css", css, classes: &[], media: &[], breakpoints: &[] }),
            event: None,
            view: None,
            anchor: &0,
        }
    }

    #[test]
    fn a_name_from_data_is_found_only_when_the_directory_has_it() {
        let files = vec![("cards/item-1.svg".to_string(), Bytes::from_static(b"<svg/>"))];
        let mut assets = Assets::build_with(files, &[], &[], "/assets").unwrap();
        let url = assets.find("cards/item-1.svg").expect("there").to_string();
        assert_eq!(url, format!("{}cards/item-1.svg", assets.prefix()));
        assert!(assets.find("cards/item-2.svg").is_none());
        assets.owner = Some("shop::Static");
        let file = Asset::__embedded("shop::Static", "cards/item-1.svg");
        assert_eq!(assets.asset(file).to_string(), url);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "is a file of admin::Static")]
    fn another_apps_file_is_found_in_debug_builds() {
        let files = vec![("style.css".to_string(), Bytes::from_static(b"a{}"))];
        let mut assets = Assets::build_with(files, &[], &[], "/assets").unwrap();
        assets.owner = Some("shop::Static");
        let _ = assets.asset(Asset::__embedded("admin::Static", "style.css"));
    }

    #[test]
    fn scripts_are_files_of_the_same_version() {
        let root = dir("scripts", &[("style.css", "a{}")]);
        let plain = Assets::load(&root, "/assets").unwrap();
        let with = Assets::build(Some(&root), &[SCRIPT], "/assets").unwrap();
        assert!(with.has_script("x_y") && with.contains("scripts/x_y.js") && !plain.has_script("x_y"));
        assert_ne!(plain.version(), with.version(), "a script change is a new version");
        let only = Assets::build(None, &[SCRIPT], "/assets").unwrap();
        assert!(only.has_script("x_y"), "an app needs no static directory for its scripts");
        assert!(
            only.stylesheet().is_none() && only.events().is_none(),
            "no stylesheet or events without components that have them"
        );
        let clash = dir("clash", &[("scripts/x_y.js", "export default 1")]);
        let error = Assets::build(Some(&clash), &[SCRIPT], "/assets").err().expect("one name, two scripts");
        assert!(error.to_string().contains("two scripts named x_y"), "{error}");
    }

    /// `corten/keys` is served when a listed script imports it, mapped and preloaded with that
    /// script; nothing else brings it, so a static script that imports it alone, or a static file
    /// of its name, is an error when the app starts.
    #[test]
    fn corten_keys_is_served_only_for_a_listed_script_that_imports_it() {
        const fn script(name: &'static str, imports: &'static [&'static str]) -> Component {
            Component {
                name,
                script: Some(crate::Script { name, file: name, source: name, handlers: &[], events: &[], imports }),
                style: None,
                event: None,
                view: None,
                anchor: &0,
            }
        }
        const KEYED: Component = script("keyed", &[crate::script::KEYS_MODULE]);
        const PLAIN: Component = script("plain", &[]);
        let assets = Assets::build(None, &[KEYED, PLAIN], "/assets").unwrap();
        let dir = &assets.scripts_dir;
        assert_eq!(assets.keys(), Some(format!("{dir}corten-keys.js")));
        assert!(assets
            .module("keyed")
            .unwrap()
            .0
            .ends_with(&format!(r#"<link rel="modulepreload" href="{dir}corten-keys.js">"#)));
        assert!(!assets.module("plain").unwrap().0.contains("corten-keys"));
        assert_eq!(Assets::build(None, &[PLAIN], "/assets").unwrap().keys(), None);
        let importer = vec![("scripts/app.js".to_string(), Bytes::from_static(b"import { shortcut } from \"corten/keys\";"))];
        let error = Assets::build_with(importer, &[PLAIN], &[], "/assets").err().expect("nothing serves corten/keys");
        assert!(error.to_string().contains("scripts/app.js imports corten/keys"), "{error}");
        let taken = vec![("scripts/corten-keys.js".to_string(), Bytes::from_static(b"export const shortcut = 1;"))];
        let error = Assets::build_with(taken, &[PLAIN], &[], "/assets").err().expect("the name is Corten's");
        assert!(error.to_string().contains("Corten's keys module"), "{error}");
    }

    /// `corten/views` is mapped only for an app with a view, though `tsc` sees `rows()` and
    /// `view()` declared for every app: a script of an app without one that imports it is an
    /// error when the app starts, not in the browser.
    #[test]
    fn corten_views_imported_by_an_app_without_a_view_is_refused() {
        const PLAIN: Component = Component {
            name: "plain",
            script: Some(crate::Script { name: "plain", file: "plain", source: "", handlers: &[], events: &[], imports: &[] }),
            style: None,
            event: None,
            view: None,
            anchor: &0,
        };
        const VIEWING: Component = Component {
            name: "viewing",
            script: Some(crate::Script {
                name: "viewing",
                file: "viewing",
                source: "import { view } from \"corten/views\";",
                handlers: &[],
                events: &[],
                imports: &[],
            }),
            style: None,
            event: None,
            view: None,
            anchor: &0,
        };
        let error = Assets::build(None, &[VIEWING], "/assets").err().expect("nothing serves corten/views");
        assert!(error.to_string().contains("scripts/viewing.js imports corten/views"), "{error}");
        let importer = vec![("scripts/helper.js".to_string(), Bytes::from_static(b"import { rows } from \"corten/views\";"))];
        let error = Assets::build_with(importer, &[PLAIN], &[], "/assets").err().expect("nothing serves corten/views");
        assert!(error.to_string().contains("scripts/helper.js imports corten/views"), "{error}");
        assert!(Assets::build(None, &[PLAIN], "/assets").is_ok());
    }
    /// A script that imports another of its directory has it preloaded with it, and its imports
    /// in turn; a page that loads the importer fetches them at once, not once it has arrived.
    #[test]
    fn a_scripts_imports_are_preloaded_with_it() {
        const fn script(name: &'static str, imports: &'static [&'static str]) -> Component {
            Component {
                name,
                script: Some(crate::Script { name, file: name, source: name, handlers: &[], events: &[], imports }),
                style: None,
                event: None,
                view: None,
                anchor: &0,
            }
        }
        const ENTRY: Component = script("entry", &["stripe"]);
        const STRIPE: Component = script("stripe", &["theme", "entry"]);
        const THEME: Component = script("theme", &[]);
        let assets = Assets::build(None, &[ENTRY, STRIPE, THEME], "/assets").unwrap();
        let (tag, ..) = assets.module("entry").unwrap();
        let dir = &assets.scripts_dir;
        assert_eq!(
            tag,
            format!(
                r#"<script type="module" src="{dir}entry.js"></script><link rel="modulepreload" href="{dir}stripe.js"><link rel="modulepreload" href="{dir}theme.js">"#
            )
        );
        assert_eq!(assets.module("theme").unwrap().0, format!(r#"<script type="module" src="{dir}theme.js"></script>"#));
        let error = Assets::build(None, &[ENTRY], "/assets").err().expect("stripe is not listed");
        assert!(error.to_string().contains("scripts/entry.js imports ./stripe.js"), "{error}");
        // A plain script of the static directory is served too, so it may be imported.
        let files = vec![("scripts/stripe.js".to_string(), Bytes::from_static(b"export const a = 1;"))];
        let assets = Assets::build_with(files, &[ENTRY], &[], "/assets").unwrap();
        assert!(assets.module("entry").unwrap().0.ends_with("stripe.js\">"));
        assert!(!assets.module("entry").unwrap().2, "nothing imports the views");
        // One that imports the views (of an app with one) makes the listed module's pages preload
        // them, though the crate never read it.
        const ROW: Component = Component {
            name: "Row",
            script: None,
            style: None,
            event: None,
            view: Some(crate::script::ViewDef { class: "Row", js: "export class Row {}\n", ts: "" }),
            anchor: &0,
        };
        let files = vec![("scripts/stripe.js".to_string(), Bytes::from_static(b"import { list } from 'corten/views';"))];
        let assets = Assets::build_with(files, &[ENTRY, ROW], &[], "/assets").unwrap();
        assert!(assets.module("entry").unwrap().2 && assets.swap_imports("entry").unwrap().2);
        // A module that imports one that uses the typed events has them preloaded too.
        const SAVED: Component = Component {
            name: "Saved",
            script: None,
            style: None,
            event: Some(crate::script::EventDef { class: "Saved", name: "saved", fields: &[] }),
            view: None,
            anchor: &0,
        };
        const EMITS: Component = Component {
            name: "emits",
            script: Some(crate::Script {
                name: "emits",
                file: "emits.js",
                source: "",
                handlers: &[],
                events: &[SAVED],
                imports: &[],
            }),
            style: None,
            event: None,
            view: None,
            anchor: &0,
        };
        const USES: Component = script("uses", &["emits"]);
        let assets = Assets::build(None, &[USES, EMITS], "/assets").unwrap();
        assert!(assets.module("uses").unwrap().1, "the events come with the import");
    }

    #[test]
    fn typed_events_are_one_module_of_classes() {
        const TOGGLED: Component = Component {
            name: "RowToggled",
            script: None,
            style: None,
            event: Some(crate::script::EventDef { class: "RowToggled", name: "row-toggled", fields: &[] }),
            view: None,
            anchor: &0,
        };
        let assets = Assets::build(None, &[TOGGLED], "/assets").unwrap();
        assert_eq!(assets.events(), Some(assets.url(EVENTS)));
        let File { hash, .. } = &assets.files[EVENTS];
        assert_ne!(*hash, 0);
        // A script that imports the event brings it: the app lists only the script's component,
        // and listing the event as well changes nothing.
        const GRID: Component = Component {
            name: "Grid",
            script: Some(crate::Script {
                name: "grid",
                file: "grid.js",
                source: "import { RowToggled } from \"corten/events\";\nexport function f() {}",
                handlers: &["f"],
                events: &[TOGGLED],
                imports: &[],
            }),
            style: None,
            event: None,
            view: None,
            anchor: &0,
        };
        let carried = Assets::build(None, &[GRID], "/assets").unwrap();
        assert_eq!(carried.events(), Some(carried.url(EVENTS)));
        let module = |a: &Assets| {
            #[cfg(feature = "compress")]
            let body = a.files[EVENTS].body.identity();
            #[cfg(not(feature = "compress"))]
            let body = &a.files[EVENTS].body;
            String::from_utf8(body.to_vec()).unwrap()
        };
        assert!(module(&carried).contains("export const RowToggled = event(\"row-toggled\");"), "{}", module(&carried));
        let both = Assets::build(None, &[GRID, TOGGLED], "/assets").unwrap();
        assert_eq!(module(&both), module(&carried));
        // Another event of the same class (an app's own, beside a library's) is an error, not merged.
        const OTHER: Component = Component {
            event: Some(crate::script::EventDef { class: "RowToggled", name: "ui-row-toggled", fields: &[] }),
            ..TOGGLED
        };
        let error = Assets::build(None, &[GRID, OTHER], "/assets").err().expect("two RowToggled");
        assert!(error.to_string().contains("two events are RowToggled"), "{error}");
    }

    #[test]
    fn views_are_one_module_and_one_name_is_one_view() {
        const fn view(js: &'static str) -> Component {
            Component {
                name: "Row",
                script: None,
                style: None,
                event: None,
                view: Some(crate::script::ViewDef { class: "Row", js, ts: "" }),
                anchor: &0,
            }
        }
        const ROW: Component = view("export class Row {}\n");
        let assets = Assets::build(None, &[ROW, ROW], "/assets").unwrap();
        assert_eq!(assets.views(), Some(assets.url(VIEWS)));
        let module = crate::script::views_module(&[ROW, ROW]).unwrap().unwrap();
        assert_eq!(module.matches("export class Row").count(), 1, "listed twice, served once");
        assert!(module.starts_with("// The app's views"), "with the helpers the classes use");
        assert!(
            module.contains("const{checked,rows,text,value,view}=") && module.contains("export { rows, view };"),
            "and rows() and view()"
        );
        let error = Assets::build(None, &[ROW, view("export class Row { other() {} }\n")], "/assets").err().expect("two Rows");
        assert!(error.to_string().contains("two views named Row"), "{error}");
        assert!(Assets::build(None, &[SCRIPT], "/assets").unwrap().views().is_none());
    }

    #[tokio::test]
    async fn component_stylesheets_are_one_file_in_the_order_listed() {
        // (Below: a component's @media rule names a breakpoint of the token file.)
        const CSS: &str = "@media not (--sm){.card__a{gap:0}}@media (--md) and (hover){.card__a{gap:1px}}";
        let media: &'static [(usize, &'static str)] =
            Box::leak(Box::new([(CSS.find("(--sm)").unwrap(), "sm"), (CSS.find("(--md)").unwrap(), "md")]));
        let theme = |breakpoints: &'static [(&'static str, &'static str)]| Component {
            style: Some(crate::Style { breakpoints, ..styled("tokens.json", "tokens.json", ":root{--x:1}").style.unwrap() }),
            ..styled("tokens.json", "tokens.json", "")
        };
        let wide = Component {
            style: Some(crate::Style { media, ..styled("Card", "card", CSS).style.unwrap() }),
            ..styled("Card", "card", CSS)
        };
        let assets = Arc::new(Assets::build(None, &[theme(&[("sm", "40rem"), ("md", "48rem")]), wide], "/assets").unwrap());
        let url = assets.stylesheet().expect("a stylesheet").to_string();
        let res = assets.routes().oneshot(axum::http::Request::get(url).body(Body::empty()).unwrap()).await.unwrap();
        let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
        assert_eq!(
            &body[..],
            format!("{HIDDEN_RULE}:root{{--x:1}}\n@media not (min-width:40rem){{.card__a{{gap:0}}}}@media (min-width:48rem) and (hover){{.card__a{{gap:1px}}}}").as_bytes(),
            "each breakpoint is the width its md: utilities use"
        );
        let error = |components: &[Component]| Assets::build(None, components, "/assets").err().expect("an error").to_string();
        let missing = error(&[theme(&[("md", "48rem")]), wide]);
        assert!(
            missing.contains(
                "x.css (Card) names the breakpoint --sm in an @media rule, and the token files in App::components make md (48rem): add sm to $extensions.\"run.corten\".breakpoints in one of them, as a width none of them has (smallest first), or as the name of one it makes in braces (\"sm\": \"{md}\"), which one at a width it already has must be; or name one they make"
            ),
            "{missing}"
        );
        assert!(error(&[wide]).ends_with(
            "no token file in App::components makes one: add a token file that makes sm ($extensions.\"run.corten\".breakpoints)"
        ));
        // One that names another is not offered: naming it would make a chain.
        let aliased = error(&[theme(&[("md", "48rem"), ("phone", "48rem")]), wide]);
        assert!(aliased.contains("make md (48rem): add sm"), "{aliased}");
        let narrow = |breakpoints| Component {
            style: Some(crate::Style { file: "app.tokens.json", ..theme(breakpoints).style.unwrap() }),
            ..theme(breakpoints)
        };
        let plain = styled("Plain", "plain", ".plain__a{}");
        assert!(
            Assets::build(None, &[theme(&[("sm", "40rem")]), narrow(&[("sm", "36rem")]), plain], "/assets").is_ok(),
            "two widths for a name no component names start"
        );
        let two = error(&[theme(&[("sm", "40rem"), ("md", "48rem")]), narrow(&[("sm", "36rem")]), wide]);
        assert!(
            Assets::build(None, &[theme(&[("sm", "40rem"), ("md", "48rem")]), narrow(&[("sm", "40.0rem")]), wide], "/assets")
                .is_ok(),
            "40rem and 40.0rem are one width"
        );
        assert!(
            super::same_width("2.5em", "2.50em") && !super::same_width("40em", "40rem") && !super::same_width("640px", "40rem")
        );
        assert!(super::same_width("4e1rem", "40rem") && super::same_width("4e1em", "40em"), "an exponent is part of the number");
        assert!(
            two.contains("x.css (Card) names the breakpoint --sm in an @media rule, and the token files in App::components give it different widths (x.css 40rem, app.tokens.json 36rem)"),
            "{two}"
        );
        let area =
            Assets::build_with(Vec::new(), &[theme(&[("sm", "40rem"), ("md", "48rem")])], &[("/admin", &[wide])], "/assets")
                .unwrap();
        let admin = area.url("sections/admin.css");
        let res = Arc::new(area).routes().oneshot(axum::http::Request::get(admin).body(Body::empty()).unwrap()).await.unwrap();
        let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
        assert_eq!(
            &body[..],
            b"@media not (min-width:40rem){.card__a{gap:0}}@media (min-width:48rem) and (hover){.card__a{gap:1px}}",
            "an area's stylesheet has the widths too"
        );

        let tokens = styled("tokens.json", "tokens.json", ":root{--x:1}");
        let card = styled("Card", "card", ".card__a{color:red}");
        let assets = Arc::new(Assets::build(None, &[tokens, card, SCRIPT, card], "/assets").unwrap());
        let url = assets.stylesheet().expect("a stylesheet").to_string();
        assert_eq!(url, assets.url(STYLESHEET));
        let app: Router = assets.routes();
        let res = app.oneshot(axum::http::Request::get(url).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.headers()["content-type"], "text/css; charset=utf-8");
        let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
        assert_eq!(
            &body[..],
            format!("{HIDDEN_RULE}:root{{--x:1}}\n.card__a{{color:red}}").as_bytes(),
            "listed twice, joined once"
        );
        let other = Assets::build(None, &[tokens, styled("Card", "card", ".card__a{color:blue}")], "/assets").unwrap();
        assert_ne!(
            other.version(),
            Assets::build(None, &[tokens, card], "/assets").unwrap().version(),
            "a style change is a new version"
        );
        let error = Assets::build(None, &[card, styled("admin::Card", "card", ".card__b{}")], "/assets")
            .err()
            .expect("one prefix, two components");
        assert!(error.to_string().contains("both style .card__*"), "{error}");
    }

    #[test]
    fn a_stylesheet_reads_only_the_custom_properties_its_pages_declare() {
        let tokens = styled("tokens.json", "tokens.json", ":root{--ink:#111;--space-1:4px}");
        let card = styled("Card", "card", ".card__a{color:var(--ink);padding:var(--space-1)}");
        assert!(Assets::build(None, &[tokens, card], "/assets").is_ok());
        let typo = styled("Card", "card", ".card__a{color:var(--color-primary-contrast);margin:var(--gap, 0)}");
        let error = Assets::build(None, &[tokens, typo], "/assets").err().expect("an undeclared property").to_string();
        assert!(error.contains("x.css (Card) reads var(--color-primary-contrast), which no stylesheet declares"), "{error}");
        assert!(!error.contains("--gap"), "a fallback is enough: {error}");
        let root = dir("declared", &[("style.css", ":root {\n  --color-primary-contrast: white;\n}")]);
        assert!(Assets::build(Some(&root), &[tokens, typo], "/assets").is_ok(), "a static .css file declares them too");

        // An area's component reads what its pages declare, the areas around it included.
        let admin = styled("Admin", "admin", ".admin__a{--admin-ink:red}");
        let report = styled("Report", "report", ".report__a{color:var(--admin-ink)}");
        let nested: &[(&str, &[Component])] = &[("/admin", &[admin]), ("/admin/reports", &[report])];
        assert!(Assets::build_with(Vec::new(), &[tokens], nested, "/assets").is_ok());
        let apart: &[(&str, &[Component])] = &[("/admin", &[admin]), ("/reports", &[report])];
        let error =
            Assets::build_with(Vec::new(), &[tokens], apart, "/assets").err().expect("declared on other pages").to_string();
        assert!(
            error.contains("x.css (Report) reads var(--admin-ink), which no stylesheet on the pages of /reports declares"),
            "{error}"
        );
        let error = Assets::build_with(Vec::new(), &[tokens, report], &[("/admin", &[admin])], "/assets")
            .err()
            .expect("an area's")
            .to_string();
        assert!(error.contains("x.css (Report) reads var(--admin-ink), which no stylesheet declares"), "{error}");
    }

    #[tokio::test]
    async fn a_section_has_a_stylesheet_of_its_own() {
        let tokens = styled("tokens.json", "tokens.json", ":root{--x:1}");
        let card = styled("Card", "card", ".card__a{color:red}");
        let chart = styled("Chart", "chart", ".chart__a{}");
        let table = styled("Table", "table", ".table__a{}");
        let sections: &[(&str, &[Component])] =
            &[("/admin", &[chart, SCRIPT, chart]), ("/admin/reports", &[table]), ("/scripts-only", &[SCRIPT])];
        let assets = Arc::new(Assets::build_with(Vec::new(), &[tokens, card], sections, "/assets").unwrap());
        assert!(assets.has_script("x_y"), "a section's scripts are served like the rest");
        let urls: Vec<_> = assets.section_stylesheets().iter().map(|s| (s.prefixes.join(" "), s.href.clone())).collect();
        assert_eq!(
            urls,
            [
                ("/admin".to_string(), assets.url("sections/admin.css")),
                ("/admin/reports".to_string(), assets.url("sections/admin/reports.css"))
            ],
            "a section without stylesheets has no file"
        );
        let app: Router = assets.routes();
        let body = |url: String| {
            let app = app.clone();
            async move {
                let res = app.oneshot(Request::get(url).body(Body::empty()).unwrap()).await.unwrap();
                http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes()
            }
        };
        assert_eq!(
            &body(assets.url(STYLESHEET)).await[..],
            format!("{HIDDEN_RULE}:root{{--x:1}}\n.card__a{{color:red}}").as_bytes(),
            "not the sections' rules"
        );
        assert_eq!(&body(assets.url("sections/admin.css")).await[..], b".chart__a{}", "listed twice, joined once");
        let only_areas = Arc::new(Assets::build_with(Vec::new(), &[SCRIPT], &[("/admin", &[chart])], "/assets").unwrap());
        assert!(only_areas.stylesheet().is_none(), "no components.css without a stylesheet in it");
        let res = only_areas
            .routes()
            .oneshot(Request::get(only_areas.url("sections/admin.css")).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let only = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
        assert_eq!(&only[..], format!("{HIDDEN_RULE}.chart__a{{}}").as_bytes(), "an area's file has the hidden rule then");
        assert_ne!(
            assets.version(),
            Assets::build_with(Vec::new(), &[tokens, card], &[("/admin", &[table])], "/assets").unwrap().version(),
            "a section's stylesheet is part of the version"
        );

        let error = |components: &[Component], sections: &[(&str, &[Component])]| {
            Assets::build_with(Vec::new(), components, sections, "/assets").err().expect("an error").to_string()
        };
        let twice = error(&[card], &[("/admin", &[card])]);
        assert!(twice.contains("Card is listed in App::components and in the area /admin"), "{twice}");
        let in_app_and_area = error(&[chart], &[("/admin", &[]), ("/shop", &[chart])]);
        assert!(in_app_and_area.contains("Chart is listed in App::components and in the area /shop"), "{in_app_and_area}");
        // tokens! names its stylesheet by the token file's path, as both name and file.
        let tokens = Component { style: Some(crate::Style { file: "tokens.json", ..tokens.style.unwrap() }), ..tokens };
        let global = error(&[], &[("/admin", &[tokens])]);
        assert!(global.contains("tokens.json styles every page"), "{global}");
        let prefix = error(&[card], &[("/admin", &[styled("admin::Card", "card", ".card__b{}")])]);
        assert!(prefix.contains("both style .card__*"), "{prefix}");
        let root = dir("section-clash", &[("sections/admin.css", "a{}")]);
        let file = Assets::build_with(read_dir(&root).unwrap(), &[], &[("/admin", &[chart])], "/assets")
            .err()
            .expect("taken")
            .to_string();
        assert!(file.contains("has a sections/admin.css"), "{file}");
    }

    #[tokio::test]
    async fn a_component_several_sections_list_is_in_a_file_they_share() {
        let page = styled("SearchPage", "search_page", ".search_page__a{}");
        let facet = styled("Facet", "facet", ".facet__a{}");
        let saved = styled("Saved", "saved", ".saved__a{}");
        let sections: &[(&str, &[Component])] =
            &[("/search", &[page, saved, facet]), ("/categories", &[facet, page]), ("/cart", &[])];
        let assets = Arc::new(Assets::build_with(Vec::new(), &[], sections, "/assets").unwrap());
        let files: Vec<_> =
            assets.section_stylesheets().iter().map(|s| (s.prefixes.join(" "), s.href.clone(), s.components.join(" "))).collect();
        assert_eq!(
            files,
            [
                ("/search".to_string(), assets.url("sections/search.css"), "Saved".to_string()),
                ("/search /categories".to_string(), assets.url("sections/search+categories.css"), "SearchPage Facet".to_string()),
            ]
        );
        let res = assets
            .routes::<()>()
            .oneshot(Request::get(assets.url("sections/search+categories.css")).body(Body::empty()).unwrap());
        let body = http_body_util::BodyExt::collect(res.await.unwrap().into_body()).await.unwrap().to_bytes();
        assert_eq!(
            &body[..],
            format!("{HIDDEN_RULE}.search_page__a{{}}\n.facet__a{{}}").as_bytes(),
            "each once, in the order listed, after the hidden rule (no components.css has it)"
        );
    }

    #[test]
    fn any_change_changes_the_version() {
        let a = Assets::load(dir("v1", &[("a.css", "x")]), "/assets").unwrap();
        let b = Assets::load(dir("v2", &[("a.css", "y")]), "/assets").unwrap();
        let c = Assets::load(dir("v3", &[("b.css", "x")]), "/assets").unwrap();
        assert_ne!(a.version(), b.version());
        assert_ne!(a.version(), c.version());
        assert_eq!(
            a.version(),
            Assets::load(dir("v1-again", &[("a.css", "x")]), "/assets").unwrap().version(),
            "same files, same version"
        );
    }
}
