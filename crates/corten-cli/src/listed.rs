//! `corten check`'s guard for components no list names. A component with a stylesheet, script or
//! view (`#[component(css)]`, `js` or `view`) has a constant the app lists in
//! `App::components`, by hand. One that no list names passes the compiler and the tests that do not
//! draw it; then a debug build refuses the first page that does and a release build serves that
//! page without it. This reads the source, as `corten fmt` does: every such component must be an
//! element of an array literal (`&[..]` or `vec![..]`) somewhere in the crates `corten check`
//! covers, which is what a `COMPONENTS` list and a `.components(&[..])` call are, under its own name
//! or a `use .. as` one. Which pages get it is still the app's choice, and the debug build's check
//! covers that.
//!
//! Test code (an item under a `cfg` that needs `test`, the files of such a `mod x;`) is not read:
//! a test lists what it draws in its own app.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use crate::fmt::{Kind, Token, lex, matching};

/// A component no list names.
#[derive(Debug, PartialEq)]
pub struct Unlisted {
    pub name: String,
    pub file: PathBuf,
    pub line: usize,
    /// What its constant carries: `"stylesheet"`, `"script"`, `"view"`, or several joined.
    pub has: String,
}

/// What one crate's source holds.
#[derive(Default)]
struct Crate {
    defined: Vec<Unlisted>,
    listed: BTreeSet<String>,
}

/// Every component under `root/src` that has a constant and that no array in those files names.
pub fn unlisted(root: &Path) -> Result<Vec<Unlisted>, String> {
    unlisted_in(&[root.to_path_buf()])
}

/// The same over several crates read together: a component one crate defines and another lists
/// (an app listing a shared crate's `shared::Card`) is listed.
pub fn unlisted_in(roots: &[PathBuf]) -> Result<Vec<Unlisted>, String> {
    let mut defined = Vec::new();
    let mut listed = BTreeSet::new();
    for root in roots {
        let found = read(root)?;
        defined.extend(found.defined);
        listed.extend(found.listed);
    }
    defined.retain(|c| !listed.contains(&c.name));
    Ok(defined)
}

fn read(root: &Path) -> Result<Crate, String> {
    let src = root.join("src");
    let mut files = Vec::new();
    crate::fmt::collect(&src, &mut files).map_err(|e| format!("read {}: {e}", src.display()))?;
    let mut tests: BTreeSet<PathBuf> = BTreeSet::new();
    // A file a test `mod x;` names may be read before the file that names it, so read every file,
    // then drop the test ones.
    let mut read = Vec::new();
    for file in &files {
        let source = std::fs::read_to_string(file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let tokens = lex(&source).map_err(|e| format!("{}: {e}, so corten check cannot read its components", file.display()))?;
        let tokens: Vec<Token> =
            tokens.into_iter().filter(|t| !matches!(t.kind, Kind::LineComment | Kind::BlockComment)).collect();
        let scan = Scan { src: &source, tokens: &tokens };
        let skipped = scan.test_items(file, &mut tests);
        let mut found = Vec::new();
        scan.components(&skipped, &mut found);
        let mut names = BTreeSet::new();
        scan.lists(&skipped, &mut names);
        read.push((file.clone(), found, names));
    }
    let mut out = Crate::default();
    for (file, found, names) in read {
        if tests.iter().any(|t| file == *t || file.starts_with(t.with_extension(""))) {
            continue;
        }
        out.listed.extend(names);
        out.defined.extend(found.into_iter().map(|(name, line, has)| Unlisted { name, file: file.clone(), line, has }));
    }
    Ok(out)
}

struct Scan<'a> {
    src: &'a str,
    tokens: &'a [Token],
}

impl Scan<'_> {
    fn text(&self, i: usize) -> &str {
        self.tokens.get(i).and_then(|t| self.src.get(t.start..t.end)).unwrap_or("")
    }

    fn is(&self, i: usize, text: &str) -> bool {
        self.text(i) == text
    }

    fn ident(&self, i: usize) -> bool {
        self.tokens.get(i).is_some_and(|t| t.kind == Kind::Ident)
    }

    fn line(&self, i: usize) -> usize {
        self.src[..self.tokens[i].start].matches('\n').count() + 1
    }

    /// The token after the group opened at `open`.
    fn past(&self, open: usize) -> usize {
        matching(self.tokens, open).map_or(self.tokens.len(), |end| end + 1)
    }

    /// Whether the `cfg` predicate in tokens `from..to` needs `test`: it names `test` other than
    /// inside a `not(..)`.
    fn needs_test(&self, from: usize, to: usize) -> bool {
        let mut i = from;
        while i < to {
            if self.is(i, "not") && self.is(i + 1, "(") {
                i = self.past(i + 1);
                continue;
            }
            if self.is(i, "test") {
                return true;
            }
            i += 1;
        }
        false
    }

    /// The token ranges of items under a `cfg` that needs `test` (attributes through the item's end),
    /// and the files of such a `mod x;` (its `#[path]`, or `x.rs` and `x/mod.rs` where the module
    /// tree puts it), added to `tests`.
    fn test_items(&self, file: &Path, tests: &mut BTreeSet<PathBuf>) -> Vec<(usize, usize)> {
        // The inline modules (`mod a { .. }`), for where a `mod x;` inside one finds its file.
        let mut inline: Vec<(usize, usize, String)> = Vec::new();
        for i in 0..self.tokens.len() {
            if self.is(i, "mod") && self.ident(i + 1) && self.is(i + 2, "{") {
                if let Some(end) = matching(self.tokens, i + 2) {
                    inline.push((i, end, self.text(i + 1).to_string()));
                }
            }
        }
        let dir = file.parent().unwrap_or(Path::new(""));
        let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let base = if matches!(stem, "lib" | "main" | "mod") { dir.to_path_buf() } else { dir.join(stem) };
        let mut ranges = Vec::new();
        let mut i = 0;
        while i < self.tokens.len() {
            if !(self.is(i, "#") && self.is(i + 1, "[")) {
                i += 1;
                continue;
            }
            // The item's attributes, from the first.
            let start = i;
            let mut test = false;
            let mut path = None;
            let mut j = i;
            while self.is(j, "#") && self.is(j + 1, "[") {
                let close = matching(self.tokens, j + 1).unwrap_or(self.tokens.len());
                if self.is(j + 2, "cfg") && self.is(j + 3, "(") {
                    test |= self.needs_test(j + 4, close);
                }
                if self.is(j + 2, "path") && self.is(j + 3, "=") {
                    path = Some(self.text(j + 4).trim_matches('"').to_string());
                }
                j = close + 1;
            }
            if !test {
                i = j.max(i + 1);
                continue;
            }
            // The item: to its `;` or past its body.
            let mut end = j;
            while end < self.tokens.len() {
                if self.is(end, ";") {
                    break;
                }
                if self.is(end, "{") {
                    end = matching(self.tokens, end).unwrap_or(self.tokens.len() - 1);
                    break;
                }
                end = if self.tokens[end].kind == Kind::Open { self.past(end) } else { end + 1 };
            }
            let mut k = j;
            if self.is(k, "pub") {
                k += 1;
                if self.is(k, "(") {
                    k = self.past(k);
                }
            }
            if self.is(k, "mod") && self.ident(k + 1) && self.is(k + 2, ";") {
                let mut here = base.clone();
                for (_, _, name) in inline.iter().filter(|(s, e, _)| *s < start && start < *e) {
                    here.push(name);
                }
                match path {
                    Some(path) => {
                        tests.insert(dir.join(path));
                    }
                    None => {
                        let name = self.text(k + 1);
                        tests.insert(here.join(format!("{name}.rs")));
                        tests.insert(here.join(name).join("mod.rs"));
                    }
                }
            }
            ranges.push((start, end));
            i = end + 1;
        }
        ranges
    }

    /// `#[component(..)]` functions whose arguments give them a constant: own `css` or `js`
    /// (not `css = Owner`, a part drawn as its owner), or `view`.
    fn components(&self, skipped: &[(usize, usize)], found: &mut Vec<(String, usize, String)>) {
        let mut i = 0;
        while i < self.tokens.len() {
            if let Some(&(_, end)) = skipped.iter().find(|(start, _)| *start == i) {
                i = end + 1;
                continue;
            }
            if !(self.is(i, "#") && self.is(i + 1, "[")) {
                i += 1;
                continue;
            }
            let Some(close) = matching(self.tokens, i + 1) else { break };
            // `component`, `corten::component` or `::corten::component`.
            let mut j = i + 2;
            while (self.ident(j) && self.is(j + 1, "::")) || self.is(j, "::") {
                j += if self.is(j, "::") { 1 } else { 2 };
            }
            if !self.is(j, "component") || !self.is(j + 1, "(") {
                i = close + 1;
                continue;
            }
            let args_end = matching(self.tokens, j + 1).unwrap_or(close);
            let has = self.constant(j + 2, args_end);
            // The function the attribute is on.
            let mut k = close + 1;
            while k < self.tokens.len() && !self.is(k, "fn") {
                if self.is(k, "{") || self.is(k, ";") {
                    break;
                }
                k += 1;
            }
            if !has.is_empty() && self.is(k, "fn") && self.ident(k + 1) {
                found.push((self.text(k + 1).to_string(), self.line(k + 1), has.join(", ")));
            }
            i = close + 1;
        }
    }

    /// What a component's arguments (tokens `from..to`) give its constant.
    fn constant(&self, from: usize, to: usize) -> Vec<String> {
        let mut has = Vec::new();
        let mut i = from;
        while i < to {
            let owned = !self.is(i + 1, "=");
            match self.text(i) {
                "css" if owned => has.push("stylesheet".to_string()),
                "js" if owned => has.push("script".to_string()),
                "view" => has.push("view".to_string()),
                _ => {}
            }
            while i < to && !self.is(i, ",") {
                i = if self.tokens[i].kind == Kind::Open { self.past(i) } else { i + 1 };
            }
            i += 1;
        }
        has
    }

    /// The names a list may give: the last path segment of each element of every array literal
    /// (`&[Card, ui::Button]`, `vec![..]`), not an attribute's brackets, and for each `use .. as`
    /// rename named so, the name it renames.
    fn lists(&self, skipped: &[(usize, usize)], names: &mut BTreeSet<String>) {
        let mut renames: BTreeMap<String, String> = BTreeMap::new();
        let mut i = 0;
        while i < self.tokens.len() {
            if let Some(&(_, end)) = skipped.iter().find(|(start, _)| *start == i) {
                i = end + 1;
                continue;
            }
            if self.ident(i) && self.is(i + 1, "as") && self.ident(i + 2) {
                renames.insert(self.text(i + 2).to_string(), self.text(i).to_string());
            }
            if self.is(i, "[") && !(i > 0 && self.is(i - 1, "#")) && !(i > 1 && self.is(i - 1, "!") && self.is(i - 2, "#")) {
                let end = matching(self.tokens, i).unwrap_or(self.tokens.len());
                let mut last = None;
                for k in i + 1..=end.min(self.tokens.len()) {
                    if k == end || self.is(k, ",") {
                        if let Some(name) = last.take() {
                            names.insert(name);
                        }
                    } else if self.ident(k) {
                        last = Some(self.text(k).to_string());
                    }
                }
            }
            i += 1;
        }
        let renamed: Vec<String> = names.iter().filter_map(|n| renames.get(n).cloned()).collect();
        names.extend(renamed);
    }
}

/// Fails, naming each, when the crates `corten check` covers from `dir` have a component no list
/// names. The crates are read together, so one may list another's.
pub fn check(dir: &Path) -> Result<(), String> {
    let roots = crate::scripts::app_roots(dir)?;
    let mut lines = Vec::new();
    for c in unlisted_in(&roots)? {
        let file = c.file.strip_prefix(dir).unwrap_or(&c.file);
        lines.push(format!(
            "{}:{}: {} has a {}, and no list names it, so a page that draws it fails in a debug build and goes without it in a release one: name it in an array the app passes to App::components (a COMPONENTS list, or .components(&[..]))",
            file.display(),
            c.line,
            c.name,
            c.has
        ));
    }
    if lines.is_empty() {
        return Ok(());
    }
    for line in &lines {
        eprintln!("{line}");
    }
    Err(format!("{} component(s) no list names (above)", lines.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch crate with these files under `src/`.
    fn scratch(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("corten-listed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (path, text) in files {
            let path = root.join("src").join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        root
    }

    fn names(found: &[Unlisted]) -> Vec<(&str, usize, &str)> {
        found.iter().map(|c| (c.name.as_str(), c.line, c.has.as_str())).collect()
    }

    #[test]
    fn a_component_no_list_names_is_found_and_test_code_is_not_read() {
        let root = scratch(
            "found",
            &[
                (
                    "lib.rs",
                    r#"mod parts;
#[cfg(test)]
mod tests;
mod screens {
    #[cfg(test)]
    mod nested;
}
#[cfg(all(test, feature = "x"))]
#[path = "elsewhere.rs"]
mod moved;
use corten::{prelude::*, Component};
use parts::Gauge as Meter;

/// #[component(css)] fn InAComment() {}
pub const COMPONENTS: &[Component] = &[Card, parts::Panel, Meter];
const SLASH: char = '\\';

pub fn app() -> App {
    let more = vec![Live, ui::Chart];
    App::new(routes()).components(COMPONENTS).components(&more)
}

#[component(css)]
pub fn Card<C: Render>(children: C) -> impl Render { html! { <div class={Card}>{children}</div> } }

#[corten::component(js)]
fn Live() -> impl Render { html! { <p>"live"</p> } }

#[component(css = Card)]
fn CardTitle() -> impl Render { html! { <h2>"part"</h2> } }

#[component]
fn Plain() -> impl Render { html! { <p>"plain"</p> } }

#[cfg(test)]
#[component(css)]
fn OnATest() -> impl Render { html! { <p>"t"</p> } }

#[cfg(not(test))]
#[component(css)]
fn NotInTests() -> impl Render { html! { <p>"n"</p> } }

#[cfg(test)]
mod inline {
    #[component(css)]
    fn OnlyInATest() -> impl Render { html! { <p>"t"</p> } }
}
"#,
                ),
                (
                    "parts.rs",
                    r#"#[component(css)]
pub fn Panel() -> impl Render { html! { <section class={Panel}></section> } }

/// Drawn by Panel, listed nowhere.
#[component(css, js)]
pub fn DialogNotSent(said: Ref<el::HTMLParagraphElement>) -> impl Render {
    html! { <p ref={said} class={DialogNotSent} hidden>"Not sent"</p> }
}

#[component(view)]
pub fn Row(id: u32) -> impl Render { html! { <tr key={id}></tr> } }

#[component(css)]
pub fn Gauge() -> impl Render { html! { <meter class={Gauge}></meter> } }
"#,
                ),
                ("tests.rs", "#[component(css)]\nfn InTheTests() -> impl Render { html! { <p></p> } }\n"),
                ("screens/nested.rs", "#[component(css)]\nfn InANestedTest() -> impl Render { html! { <p></p> } }\n"),
                ("elsewhere.rs", "#[component(css)]\nfn AtATestPath() -> impl Render { html! { <p></p> } }\n"),
            ],
        );
        let found = unlisted(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(
            names(&found),
            [("NotInTests", 41, "stylesheet"), ("DialogNotSent", 6, "stylesheet, script"), ("Row", 11, "view")]
        );
        assert!(found[1].file.ends_with("parts.rs"));
    }

    /// A shared crate's component that only an app lists, by path, is listed when `corten check`
    /// reads both (at the workspace root).
    #[test]
    fn crates_read_together_may_list_each_others_components() {
        let shared =
            scratch("shared", &[("lib.rs", "#[component(css)]\npub fn Card() -> impl Render { html! { <div></div> } }\n")]);
        let app = scratch("app", &[("main.rs", "fn main() { App::new(r()).components(&[shared::Card]); }\n")]);
        assert_eq!(names(&unlisted(&shared).unwrap()), [("Card", 2, "stylesheet")]);
        assert_eq!(unlisted_in(&[shared.clone(), app.clone()]).unwrap(), []);
        let _ = std::fs::remove_dir_all(&shared);
        let _ = std::fs::remove_dir_all(&app);
    }

    /// Corten's own apps, `corten-ui` and the template list every component they have.
    #[test]
    fn the_examples_corten_ui_and_the_template_list_every_component() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut roots = vec![repo.join("crates/corten-ui"), Path::new(env!("CARGO_MANIFEST_DIR")).join("template")];
        for entry in std::fs::read_dir(repo.join("examples")).unwrap() {
            let path = entry.unwrap().path();
            if path.join("Cargo.toml").is_file() {
                roots.push(path);
            }
        }
        assert!(roots.len() > 4, "{roots:?}");
        for root in roots {
            assert_eq!(unlisted(&root).unwrap(), [], "{}", root.display());
        }
    }
}
