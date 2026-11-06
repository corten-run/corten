//! `corten check`'s guard for components no list names. A component with a stylesheet, script or
//! view (`#[component(css)]`, `js` or `view`) has a constant the app lists in
//! `App::components`, by hand. One that no list names passes the compiler and the tests that do not
//! draw it; then a debug build refuses the first page that does and a release build serves that
//! page without it. This reads the source, as `corten fmt` does, file by file as the compiler finds
//! them (each library and binary target's root and the files its `mod x;`s name; not a file
//! `include!` brings in or a module a macro declares): every such component must be an
//! element of an array literal (`&[..]` or `vec![..]`), which is what a `COMPONENTS` list and a
//! `.components(&[..])` call are, under its own name or a `use .. as` one, in its own crate or in a
//! workspace member that depends on it, directly or through another. An array in `html!` or in a
//! component's body (a class list) is not a list, nor is a path through a type (`Kind::Badge`).
//! Which pages get it is still the app's choice, and the debug build's check covers that.
//!
//! Test code (an item under a `cfg` that needs `test`, a file under `#![cfg(test)]`, and the files
//! of a `mod x;` in either) is not read: a test lists what it draws in its own app.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use crate::fmt::{Kind, Token, lex, matching};

/// A component no list names.
#[derive(Clone, Debug, PartialEq)]
pub struct Unlisted {
    pub name: String,
    pub file: PathBuf,
    pub line: usize,
    /// What its constant carries: `"stylesheet"`, `"script"`, `"view"`, or several joined.
    pub has: String,
}

/// A workspace member that uses corten: its package name, its directory, the root file of each of
/// its library and binary targets (`src/lib.rs`, a `[[bin]] path`) and the packages it depends on.
pub struct Member {
    pub name: String,
    pub root: PathBuf,
    pub targets: Vec<PathBuf>,
    pub uses: Vec<String>,
}

/// What one crate's source holds.
#[derive(Default)]
struct Crate {
    defined: Vec<Unlisted>,
    /// The names its arrays give, with what its renames stand for.
    listed: BTreeSet<String>,
    /// `use X as Y`: Y to each X, for the whole crate (a `pub use` in one file, the list in another).
    renames: BTreeMap<String, BTreeSet<String>>,
}

/// Every component in the crate at `root` (`src/lib.rs` and `src/main.rs` and their modules)
/// that has a constant and that no array in it names.
#[cfg(test)]
fn unlisted(root: &Path) -> Result<Vec<Unlisted>, String> {
    let targets = vec![root.join("src/lib.rs"), root.join("src/main.rs")];
    let member = Member { name: String::new(), root: root.to_path_buf(), targets, uses: Vec::new() };
    unlisted_in(&[member], &[root.to_path_buf()])
}

/// The components of the members in `checked` (their directories) that no array names in their own
/// crate or in a member that depends on it, directly or through other members (an app listing a
/// shared crate's `shared::Card`), by its name or a name a rename in one of those crates gives it.
/// One app's list does not cover another's component of the same name.
pub fn unlisted_in(all: &[Member], checked: &[PathBuf]) -> Result<Vec<Unlisted>, String> {
    let read: Vec<Crate> = all.iter().map(|member| read(&member.targets)).collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    for (at, (member, found)) in all.iter().zip(&read).enumerate() {
        if !checked.contains(&member.root) {
            continue;
        }
        // This crate and every member that depends on it, through others too.
        let mut near = vec![at];
        let mut k = 0;
        while k < near.len() {
            let name = &all[near[k]].name;
            for (i, other) in all.iter().enumerate() {
                if !near.contains(&i) && other.uses.contains(name) {
                    near.push(i);
                }
            }
            k += 1;
        }
        let listed = |name: &String| {
            // Its name, and each a rename gives it or a name it was given, to the last.
            let mut names = vec![name.clone()];
            let mut k = 0;
            while k < names.len() {
                for &i in &near {
                    for (to, from) in &read[i].renames {
                        if from.contains(&names[k]) && !names.contains(to) {
                            names.push(to.clone());
                        }
                    }
                }
                k += 1;
            }
            near.iter().any(|&i| names.iter().any(|n| read[i].listed.contains(n)))
        };
        out.extend(found.defined.iter().filter(|c| !listed(&c.name)).cloned());
    }
    Ok(out)
}

/// The files of a crate, as the compiler finds them: each target's root and the files its `mod x;`
/// declarations name (`x.rs`, `x/mod.rs` or a `#[path]`), not those of a declaration only a test
/// build has, which are test code.
fn read(targets: &[PathBuf]) -> Result<Crate, String> {
    // Each file with whether its own `mod x;` files are beside it (a target's root, or a file a
    // `#[path]` names) rather than under a directory named after it.
    let mut queue: Vec<(PathBuf, bool)> = targets.iter().map(|t| (t.clone(), true)).collect();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let mut read = Vec::new();
    while let Some((file, owns)) = queue.pop() {
        // A module's file is one of two places (`x.rs` or `x/mod.rs`); a target with no file has none.
        // One file reached by two spellings (`a/../b.rs`) is read once.
        if !file.is_file() || !seen.insert(file.canonicalize().unwrap_or_else(|_| file.clone())) {
            continue;
        }
        let source = std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let tokens = lex(&source).map_err(|e| format!("{}: {e}, so corten check cannot read its components", file.display()))?;
        let tokens: Vec<Token> =
            tokens.into_iter().filter(|t| !matches!(t.kind, Kind::LineComment | Kind::BlockComment)).collect();
        let scan = Scan { src: &source, tokens: &tokens, root: owns };
        let skipped = scan.test_items();
        queue.extend(scan.modules(&file, &skipped));
        let mut found = Vec::new();
        scan.components(&skipped, &mut found);
        let mut names = BTreeSet::new();
        let mut renames: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        scan.lists(&skipped, &mut names, &mut renames);
        read.push((file.clone(), found, names, renames));
    }
    let mut out = Crate::default();
    for (file, found, names, more) in read {
        out.listed.extend(names);
        for (to, from) in more {
            out.renames.entry(to).or_default().extend(from);
        }
        out.defined.extend(found.into_iter().map(|(name, line, has)| Unlisted { name, file: file.clone(), line, has }));
    }
    let renamed: Vec<String> = out.listed.iter().filter_map(|n| out.renames.get(n)).flatten().cloned().collect();
    out.listed.extend(renamed);
    Ok(out)
}

struct Scan<'a> {
    src: &'a str,
    tokens: &'a [Token],
    /// A target's root file or one a `#[path]` names, whose `mod x;` files are beside it whatever
    /// its name, as they are a `mod.rs`'s.
    root: bool,
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

    /// `::`, which the lexer gives as two `:`.
    fn colons(&self, i: usize) -> bool {
        self.is(i, ":") && self.is(i + 1, ":")
    }

    fn line(&self, i: usize) -> usize {
        self.src[..self.tokens[i].start].matches('\n').count() + 1
    }

    /// The token after the group opened at `open`.
    fn past(&self, open: usize) -> usize {
        matching(self.tokens, open).map_or(self.tokens.len(), |end| end + 1)
    }

    /// Whether the `cfg` predicate in tokens `from..to` holds only in a test build: `test`,
    /// `all(..)` with one such, `any(..)` with every one such; not `not(..)` or anything else.
    fn needs_test(&self, from: usize, to: usize) -> bool {
        // The predicates at this level, split at commas.
        let mut parts = Vec::new();
        let mut start = from;
        let mut i = from;
        while i < to {
            if self.is(i, ",") {
                parts.push((start, i));
                start = i + 1;
                i += 1;
            } else {
                i = if self.tokens[i].kind == Kind::Open { self.past(i) } else { i + 1 };
            }
        }
        if start < to {
            parts.push((start, to));
        }
        let one = |(a, b): (usize, usize)| -> bool {
            if b == a + 1 {
                return self.is(a, "test");
            }
            let close = matching(self.tokens, a + 1).unwrap_or(b);
            match (self.text(a), self.is(a + 1, "(")) {
                ("all", true) => self.needs_test(a + 2, close),
                ("any", true) => {
                    // Every alternative needs it: `any(test)`, not `any(test, feature = "x")`.
                    let mut k = a + 2;
                    let mut all = k < close;
                    while k < close {
                        let mut e = k;
                        while e < close && !self.is(e, ",") {
                            e = if self.tokens[e].kind == Kind::Open { self.past(e) } else { e + 1 };
                        }
                        all &= self.needs_test(k, e);
                        k = e + 1;
                    }
                    all
                }
                _ => false,
            }
        };
        parts.len() == 1 && one(parts[0]) || parts.len() > 1 && parts.into_iter().any(one)
    }

    /// The token ranges of items under a `cfg` that needs `test` (attributes through the item's end),
    /// the whole file under `#![cfg(test)]`. A `mod x;` in one is not followed.
    fn test_items(&self) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        // `#![cfg(test)]` at the top: the whole file is test code.
        let mut i = 0;
        while self.is(i, "#") && self.is(i + 1, "!") && self.is(i + 2, "[") {
            let close = matching(self.tokens, i + 2).unwrap_or(self.tokens.len());
            if self.is(i + 3, "cfg")
                && self.is(i + 4, "(")
                && self.needs_test(i + 5, matching(self.tokens, i + 4).unwrap_or(close))
            {
                return vec![(0, self.tokens.len())];
            }
            i = close + 1;
        }
        while i < self.tokens.len() {
            if !(self.is(i, "#") && self.is(i + 1, "[")) {
                i += 1;
                continue;
            }
            // The item's attributes, from the first.
            let start = i;
            let mut test = false;
            let mut j = i;
            while self.is(j, "#") && self.is(j + 1, "[") {
                let close = matching(self.tokens, j + 1).unwrap_or(self.tokens.len());
                if self.is(j + 2, "cfg") && self.is(j + 3, "(") {
                    let cfg_close = matching(self.tokens, j + 3).unwrap_or(close);
                    test |= self.needs_test(j + 4, cfg_close);
                }
                j = close + 1;
            }
            if !test {
                i = j.max(i + 1);
                continue;
            }
            let mut k = j;
            if self.is(k, "pub") {
                k += 1;
                if self.is(k, "(") {
                    k = self.past(k);
                }
            }
            // On a field, a variant, a struct literal's field, a match arm or an expression the
            // attribute covers less than an item, and reading to the next `;` or body would run
            // past the `}` around it: only the attribute is passed over.
            let item = matches!(
                self.text(k),
                "mod"
                    | "fn"
                    | "impl"
                    | "struct"
                    | "enum"
                    | "const"
                    | "static"
                    | "use"
                    | "type"
                    | "trait"
                    | "extern"
                    | "union"
                    | "async"
                    | "unsafe"
                    | "macro_rules"
                    | "let"
            );
            if !item {
                i = j;
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
            ranges.push((start, end));
            i = end + 1;
        }
        ranges
    }

    /// The inline modules (`mod a { .. }`, for where a `mod x;` inside one finds its file) and the
    /// directory a `mod x;` of the file's own finds its file in: beside a target's root or a
    /// `mod.rs`, under `x/` for `x.rs`.
    fn module_places(&self, file: &Path) -> (Vec<(usize, usize, String)>, PathBuf) {
        let mut inline: Vec<(usize, usize, String)> = Vec::new();
        for i in 0..self.tokens.len() {
            if self.is(i, "mod")
                && self.ident(i + 1)
                && self.is(i + 2, "{")
                && let Some(end) = matching(self.tokens, i + 2)
            {
                inline.push((i, end, self.text(i + 1).to_string()));
            }
        }
        let dir = file.parent().unwrap_or(Path::new(""));
        let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let base = if self.root || stem == "mod" { dir.to_path_buf() } else { dir.join(stem) };
        (inline, base)
    }

    /// The files of each `mod x;` in the file outside `skipped` (test code), each with whether its
    /// own `mod`s are beside it: `x.rs` and `x/mod.rs` under the inline modules around it, or its
    /// `#[path]`, beside the file or under those modules' directory, whose `mod`s are beside it.
    fn modules(&self, file: &Path, skipped: &[(usize, usize)]) -> Vec<(PathBuf, bool)> {
        let (inline, base) = self.module_places(file);
        let dir = file.parent().unwrap_or(Path::new(""));
        let mut out = Vec::new();
        let mut path = None;
        for k in 0..self.tokens.len() {
            if self.is(k, "#") && self.is(k + 1, "[") && self.is(k + 2, "path") && self.is(k + 3, "=") {
                path = Some(self.text(k + 4).trim_matches('"').to_string());
                continue;
            }
            if self.is(k, ";") || self.is(k, "{") || self.is(k, "}") {
                path = None;
            }
            if !(self.is(k, "mod") && self.ident(k + 1) && self.is(k + 2, ";")) {
                continue;
            }
            // A declaration only a test build has: its file is test code.
            if skipped.iter().any(|&(s, e)| s <= k && k <= e) {
                path = None;
                continue;
            }
            let mut here = base.clone();
            let mut nested = false;
            for (_, _, name) in inline.iter().filter(|(s, e, _)| *s < k && k < *e) {
                here.push(name);
                nested = true;
            }
            let name = self.text(k + 1);
            match path.take() {
                Some(path) => out.push((if nested { here.join(path) } else { dir.join(path) }, true)),
                None => {
                    out.push((here.join(format!("{name}.rs")), false));
                    out.push((here.join(name).join("mod.rs"), true));
                }
            }
        }
        out
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
            while (self.ident(j) && self.colons(j + 1)) || self.colons(j) {
                j += if self.colons(j) { 2 } else { 3 };
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

    /// When an attribute at `i` is `#[component..]` on a function, the token after its body.
    fn component_body(&self, i: usize) -> Option<usize> {
        if !(self.is(i, "#") && self.is(i + 1, "[")) {
            return None;
        }
        let close = matching(self.tokens, i + 1)?;
        let mut j = i + 2;
        while (self.ident(j) && self.colons(j + 1)) || self.colons(j) {
            j += if self.colons(j) { 2 } else { 3 };
        }
        if !self.is(j, "component") || !(self.is(j + 1, "]") || self.is(j + 1, "(")) {
            return None;
        }
        let mut k = close + 1;
        while k < self.tokens.len() {
            if self.is(k, "{") {
                return Some(self.past(k));
            }
            if self.is(k, ";") {
                return None;
            }
            k = if self.tokens[k].kind == Kind::Open { self.past(k) } else { k + 1 };
        }
        None
    }

    /// The names a list may give: the last path segment of each element of every array literal
    /// (`&[Card, ui::Button]`, `vec![..]`), not an attribute's brackets, and for each `use .. as`
    /// rename named so, the name it renames.
    ///
    /// Not inside `html!` (a class list, `class={[Row, Selected]}`, names the component's own
    /// classes, not the component), and not a path through a type (`Kind::Badge`, a variant).
    fn lists(&self, skipped: &[(usize, usize)], names: &mut BTreeSet<String>, renames: &mut BTreeMap<String, BTreeSet<String>>) {
        let mut i = 0;
        while i < self.tokens.len() {
            if let Some(&(_, end)) = skipped.iter().find(|(start, _)| *start == i) {
                i = end + 1;
                continue;
            }
            if self.is(i, "html") && self.is(i + 1, "!") && self.tokens.get(i + 2).is_some_and(|t| t.kind == Kind::Open) {
                i = self.past(i + 2);
                continue;
            }
            // A component's body: no list belongs in its markup or its looks (`[Tile, Raised]`).
            if let Some(body) = self.component_body(i) {
                i = body;
                continue;
            }
            if self.ident(i) && self.is(i + 1, "as") && self.ident(i + 2) {
                renames.entry(self.text(i + 2).to_string()).or_default().insert(self.text(i).to_string());
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
                        let through_type =
                            k > 2 && self.colons(k - 2) && self.text(k - 3).starts_with(|c: char| c.is_ascii_uppercase());
                        last = (!through_type).then(|| self.text(k).to_string());
                    }
                }
            }
            i += 1;
        }
    }
}

/// Fails, naming each, when the crates `corten check` covers from `dir` have a component no list
/// names. Every workspace member that uses corten is read for lists, so one may list another's
/// from wherever the check runs.
pub fn check(dir: &Path) -> Result<(), String> {
    let (all, checked) = crate::scripts::app_roots(dir)?;
    let mut lines = Vec::new();
    for c in unlisted_in(&all, &checked)? {
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

    /// A class list in markup and a variant of the same name do not list a component; a `pub use`
    /// rename in one file counts for a list in another; a test-only file, a test module at a
    /// `#[path]` inside an inline module, and only an item under a cfg that holds only in tests,
    /// are skipped (#970 review).
    #[test]
    fn what_lists_a_component_and_what_is_test_code() {
        let root = scratch(
            "edges",
            &[
                (
                    "lib.rs",
                    r#"mod layout;
mod support;
mod a {
    #[cfg(test)]
    #[path = "t.rs"]
    mod t;
}
pub const COMPONENTS: &[Component] = &[layout::Meter, Kind::Badge];
#[component(css)]
fn Row(selected: bool) -> impl Render { html! { <tr class={[Row, Selected]}></tr> } }
#[component(css)]
fn Badge() -> impl Render { html! { <span class={Badge}></span> } }
#[cfg(any(test, feature = "demo"))]
#[component(css)]
fn Demo() -> impl Render { html! { <p></p> } }
#[corten::component(js)]
fn PathAttr() -> impl Render { html! { <p></p> } }
#[cfg(any(test, test))]
#[component(css)]
fn TestOnly() -> impl Render { html! { <p></p> } }
"#,
                ),
                (
                    "layout.rs",
                    "pub use crate::parts::Gauge as Meter;\n#[component(css)]\npub fn Gauge() -> impl Render { html! { <meter></meter> } }\n",
                ),
                ("support.rs", "#![cfg(test)]\n#[component(css)]\nfn Helper() -> impl Render { html! { <p></p> } }\n"),
                ("a/t.rs", "#[component(css)]\nfn Nested() -> impl Render { html! { <p></p> } }\n"),
            ],
        );
        let found = unlisted(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let found: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(found, ["Row", "Badge", "Demo", "PathAttr"]);
    }

    /// A shared crate's component that only an app lists, by path, is listed when `corten check`
    /// reads both (at the workspace root or in the shared crate's directory), as long as the app
    /// depends on it: another app's list of a component of the same name does not count.
    #[test]
    fn crates_read_together_may_list_each_others_components() {
        let shared =
            scratch("shared", &[("lib.rs", "#[component(css)]\npub fn Card() -> impl Render { html! { <div></div> } }\n")]);
        let app = scratch("app", &[("main.rs", "fn main() { App::new(r()).components(&[shared::Card]); }\n")]);
        let other = scratch(
            "other",
            &[("main.rs", "#[component(css)]\nfn Layout() -> impl Render { html! { <p></p> } }\nfn main() {}\n")],
        );
        let lister = scratch("lister", &[("main.rs", "fn main() { App::new(r()).components(&[Layout]); }\n")]);
        assert_eq!(names(&unlisted(&shared).unwrap()), [("Card", 2, "stylesheet")]);
        let member = |name: &str, root: &PathBuf, uses: &[&str]| Member {
            name: name.into(),
            root: root.clone(),
            targets: vec![root.join("src/lib.rs"), root.join("src/main.rs")],
            uses: uses.iter().map(|u| u.to_string()).collect(),
        };
        let all = [
            member("shared", &shared, &[]),
            member("app", &app, &["shared"]),
            member("other", &other, &[]),
            member("lister", &lister, &[]),
        ];
        assert_eq!(unlisted_in(&all, &[shared.clone(), app.clone()]).unwrap(), []);
        assert_eq!(unlisted_in(&all, std::slice::from_ref(&shared)).unwrap(), []);
        assert_eq!(names(&unlisted_in(&all, std::slice::from_ref(&other)).unwrap()), [("Layout", 2, "stylesheet")]);
        let alone = [member("shared", &shared, &[]), member("app", &app, &[])];
        assert_eq!(names(&unlisted_in(&alone, std::slice::from_ref(&shared)).unwrap()), [("Card", 2, "stylesheet")]);
        for root in [shared, app, other, lister] {
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// A `cfg(test)` on a field, a variant or a struct literal's field covers only that, not the
    /// items after it; a list in a `#[path]` module outside `src/` counts; a `[[bin]]` root's
    /// `mod x;` is beside it; and a member with no `src/` reads as empty (#978 review).
    #[test]
    fn the_files_are_the_compilers_and_a_test_field_hides_nothing_after_it() {
        let root = scratch(
            "tree",
            &[
                (
                    "lib.rs",
                    r#"#[path = "../shared/list.rs"]
mod list;
struct State {
    #[cfg(test)]
    clock: u8,
    name: String,
}
#[component(css)]
pub fn AfterAField() -> impl Render { html! { <p></p> } }
enum Kind {
    #[cfg(test)]
    Fake,
    Real,
}
pub const COMPONENTS: &[Component] = &[Card];
fn state() -> State {
    State {
        #[cfg(test)]
        clock: 0,
        name: String::new(),
    }
}
#[component(css)]
pub fn Card() -> impl Render { html! { <div></div> } }
#[component(css)]
pub fn Panel() -> impl Render { html! { <div></div> } }
"#,
                ),
                ("unreached.rs", "#[component(css)]\nfn NoModNamesIt() -> impl Render { html! { <p></p> } }\n"),
            ],
        );
        std::fs::create_dir_all(root.join("shared")).unwrap();
        std::fs::write(root.join("shared/list.rs"), "pub const MORE: &[Component] = &[super::Panel];\n").unwrap();
        let found = unlisted(&root).unwrap();
        assert_eq!(names(&found), [("AfterAField", 9, "stylesheet")]);
        // A binary at `bin/admin.rs`, with no `src/`: its `mod pages;` is `bin/pages.rs`.
        let bin = std::env::temp_dir().join(format!("corten-listed-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bin);
        std::fs::create_dir_all(bin.join("bin")).unwrap();
        std::fs::write(bin.join("bin/admin.rs"), "mod pages;\nfn main() { App::new(r()).components(&[pages::Desk]); }\n")
            .unwrap();
        std::fs::write(
            bin.join("bin/pages.rs"),
            "#[component(css)]\npub fn Desk() -> impl Render {}\n#[component(css)]\npub fn Loose() -> impl Render {}\n",
        )
        .unwrap();
        let member =
            Member { name: "admin".into(), root: bin.clone(), targets: vec![bin.join("bin/admin.rs")], uses: Vec::new() };
        let found = unlisted_in(&[member], std::slice::from_ref(&bin)).unwrap();
        assert_eq!(names(&found), [("Loose", 4, "stylesheet")]);
        assert!(found[0].file.ends_with("bin/pages.rs"));
        let empty =
            Member { name: "empty".into(), root: bin.join("none"), targets: vec![bin.join("none/src/lib.rs")], uses: Vec::new() };
        assert_eq!(unlisted_in(&[empty], &[bin.join("none")]).unwrap(), []);
        for dir in [root, bin] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A rename in the crate that defines a component counts for a list in a crate that depends on
    /// it, and so does a list in a crate that reaches it through a middle crate (#970 review 4).
    #[test]
    fn a_rename_and_a_middle_crate_carry_a_list_across_crates() {
        let shared = scratch(
            "renamed",
            &[
                ("lib.rs", "mod card;\npub use card::Card as Tile;\n"),
                ("card.rs", "#[component(css)]\npub fn Card() -> impl Render { html! { <div></div> } }\n"),
            ],
        );
        let app = scratch("tiles", &[("main.rs", "fn main() { App::new(r()).components(&[shared::Tile]); }\n")]);
        let base = scratch("base", &[("lib.rs", "#[component(css)]\npub fn Badge() -> impl Render { html! { <b></b> } }\n")]);
        let middle = scratch("middle", &[("lib.rs", "pub use base::Badge;\n")]);
        let top = scratch("top", &[("main.rs", "fn main() { App::new(r()).components(&[middle::Badge, mid::Square]); }\n")]);
        let mid = scratch("mid", &[("lib.rs", "pub use shared::Tile as Square;\n")]);
        let member = |name: &str, root: &PathBuf, uses: &[&str]| Member {
            name: name.into(),
            root: root.clone(),
            targets: vec![root.join("src/lib.rs"), root.join("src/main.rs")],
            uses: uses.iter().map(|u| u.to_string()).collect(),
        };
        let all = [
            member("shared", &shared, &[]),
            member("tiles", &app, &["shared"]),
            member("base", &base, &[]),
            member("middle", &middle, &["base"]),
            member("top", &top, &["middle", "mid"]),
            member("mid", &mid, &["shared"]),
        ];
        assert_eq!(unlisted_in(&all, std::slice::from_ref(&shared)).unwrap(), []);
        assert_eq!(unlisted_in(&all, std::slice::from_ref(&base)).unwrap(), []);
        // `top` lists `Card` only through two renames, `Tile` then `Square`.
        let chain = [member("shared", &shared, &[]), member("mid", &mid, &["shared"]), member("top", &top, &["mid"])];
        assert_eq!(unlisted_in(&chain, std::slice::from_ref(&shared)).unwrap(), []);
        let cut = [member("base", &base, &[]), member("middle", &middle, &[]), member("top", &top, &["middle"])];
        assert_eq!(names(&unlisted_in(&cut, std::slice::from_ref(&base)).unwrap()), [("Badge", 2, "stylesheet")]);
        for root in [shared, app, base, middle, top, mid] {
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    /// A component's body lists nothing (a look's class array), two renames to one name each count,
    /// and a `mod x;` inside test code is test code, at its `#[path]` when it has one (#970 reviews 3
    /// and 4).
    #[test]
    fn a_components_body_lists_nothing_and_test_modules_nest() {
        let root = scratch(
            "nested",
            &[
                (
                    "lib.rs",
                    r#"mod a;
mod b;
mod support;
#[cfg(test)]
mod t {
    mod fixtures;
    #[path = "helpers/fx.rs"]
    mod fx;
}
pub const COMPONENTS: &[Component] = &[a::Meter, b::Meter];
#[component(css)]
fn Tile() -> impl ClassList { [Tile, Raised] }
#[component(css)]
fn Row(on: bool) -> impl Render { let c = [Row, On]; html! { <tr class={c}></tr> } }
"#,
                ),
                (
                    "a.rs",
                    "pub use crate::parts::Gauge as Meter;\n#[component(css)]\npub fn Gauge() -> impl Render { html! { <meter></meter> } }\n",
                ),
                (
                    "b.rs",
                    "pub use crate::parts::Dial as Meter;\n#[component(css)]\npub fn Dial() -> impl Render { html! { <meter></meter> } }\n",
                ),
                ("support.rs", "#![cfg(test)]\nmod fixtures;\n#[path = \"fixture_impl.rs\"]\nmod more;\n"),
                ("fixture_impl.rs", "#[component(css)]\nfn BesideFixture() -> impl Render { html! { <p></p> } }\n"),
                ("support/fixtures.rs", "#[component(css)]\nfn Fixture() -> impl Render { html! { <p></p> } }\n"),
                ("t/fixtures.rs", "#[component(css)]\nfn InlineFixture() -> impl Render { html! { <p></p> } }\n"),
                ("t/helpers/fx.rs", "#[component(css)]\nfn PathFixture() -> impl Render { html! { <p></p> } }\n"),
            ],
        );
        let found = unlisted(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let found: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(found, ["Tile", "Row"]);
    }

    /// A `#[path]` file's `mod x;` is beside it, as a `mod.rs`'s is; a test-only declaration of a
    /// file another declaration also names hides nothing (#978 review 2).
    #[test]
    fn a_path_files_modules_are_beside_it_and_a_test_declaration_hides_no_real_one() {
        let root = scratch(
            "pathmods",
            &[
                (
                    "lib.rs",
                    r#"#[path = "screens/home_page.rs"]
mod home;
#[cfg(test)]
#[path = "real.rs"]
mod fake;
mod real;
pub const COMPONENTS: &[Component] = &[];
"#,
                ),
                (
                    "screens/home_page.rs",
                    "mod parts;
",
                ),
                (
                    "screens/parts.rs",
                    "#[component(css)]
pub fn Beside() -> impl Render { html! { <p></p> } }
",
                ),
                (
                    "screens/home_page/parts.rs",
                    "#[component(css)]
pub fn Under() -> impl Render { html! { <p></p> } }
",
                ),
                (
                    "real.rs",
                    "#[component(css)]
pub fn Real() -> impl Render { html! { <p></p> } }
",
                ),
            ],
        );
        let found = unlisted(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let found: Vec<&str> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(found, ["Real", "Beside"]);
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
