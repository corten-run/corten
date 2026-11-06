//! `corten check`'s guard for components no list names. A component with a stylesheet, script or
//! view (`#[component(css)]`, `js` or `view`) has a constant the app lists in
//! `App::components`, by hand. One that no list names passes the compiler and the tests that do not
//! draw it; then a debug build refuses the first page that does and a release build serves that
//! page without it. The compiler cannot tell: `html!` names a child by its struct, which may be a
//! hand-written `Render` with no constant, and its generic arguments are known only where it is
//! drawn. So this reads the crate's source instead, as `corten fmt` does: every such component
//! must be named in a `COMPONENTS`-style list (an item typed `[Component]`) or a
//! `.components(&[..])` call somewhere in its crate. Which pages get it is still the app's choice,
//! and the debug build's check covers that.
//!
//! Test code (`#[cfg(test)]` modules, inline or in their own files) is not read: a test lists what it
//! draws in its own app.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use crate::fmt::{Kind, Token, lex, matching};

/// A component the crate does not list.
#[derive(Debug, PartialEq)]
pub struct Unlisted {
    pub name: String,
    pub file: PathBuf,
    pub line: usize,
    /// What its constant carries: `"stylesheet"`, `"script"` or `"view"`.
    pub has: &'static str,
}

/// Every component under `root/src` that has a constant and that no list in those files names.
pub fn unlisted(root: &Path) -> Result<Vec<Unlisted>, String> {
    let mut files = Vec::new();
    crate::fmt::collect(&root.join("src"), &mut files).map_err(|e| format!("read {}: {e}", root.join("src").display()))?;
    let mut tests: BTreeSet<PathBuf> = BTreeSet::new();
    let mut defined = Vec::new();
    let mut listed = BTreeSet::new();
    // A file a `#[cfg(test)] mod x;` names is found before or after the file that names it, so
    // read every file, then drop the test ones.
    let mut read = Vec::new();
    for file in &files {
        let source = std::fs::read_to_string(file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let Ok(tokens) = lex(&source) else { continue };
        let tokens: Vec<Token> =
            tokens.into_iter().filter(|t| !matches!(t.kind, Kind::LineComment | Kind::BlockComment)).collect();
        let scan = Scan { src: &source, tokens: &tokens };
        let skipped = scan.test_modules(file, &mut tests);
        let mut found = Vec::new();
        scan.components(&skipped, &mut found);
        let mut names = BTreeSet::new();
        scan.lists(&skipped, &mut names);
        read.push((file.clone(), found, names));
    }
    for (file, found, names) in read {
        if tests.iter().any(|t| file == *t || file.starts_with(t.with_extension(""))) {
            continue;
        }
        listed.extend(names);
        defined.extend(found.into_iter().map(|(name, line, has)| Unlisted { name, file: file.clone(), line, has }));
    }
    defined.retain(|c| !listed.contains(&c.name));
    Ok(defined)
}

struct Scan<'a> {
    src: &'a str,
    tokens: &'a [Token],
}

impl Scan<'_> {
    fn text(&self, i: usize) -> &str {
        self.tokens.get(i).map_or("", |t| &self.src[t.start..t.end])
    }

    fn is(&self, i: usize, text: &str) -> bool {
        self.text(i) == text
    }

    fn line(&self, i: usize) -> usize {
        self.src[..self.tokens[i].start].matches('\n').count() + 1
    }

    /// The token ranges of `#[cfg(test)] mod x { .. }`, and the files of `#[cfg(test)] mod x;`
    /// (`x.rs` and `x/` beside `file`, or under its own directory when `file` is not a
    /// `lib.rs`, `main.rs` or `mod.rs`), added to `tests`.
    fn test_modules(&self, file: &Path, tests: &mut BTreeSet<PathBuf>) -> Vec<(usize, usize)> {
        let mut ranges = Vec::new();
        let mut i = 0;
        while i < self.tokens.len() {
            let cfg_test = self.is(i, "#")
                && self.is(i + 1, "[")
                && self.is(i + 2, "cfg")
                && self.is(i + 3, "(")
                && self.is(i + 4, "test")
                && self.is(i + 5, ")")
                && self.is(i + 6, "]");
            if !cfg_test {
                i += 1;
                continue;
            }
            // Past this and any other attributes, and a visibility.
            let mut j = i + 7;
            while self.is(j, "#") && self.is(j + 1, "[") {
                j = matching(self.tokens, j + 1).map_or(j + 2, |end| end + 1);
            }
            if self.is(j, "pub") {
                j += 1;
                if self.is(j, "(") {
                    j = matching(self.tokens, j).map_or(j + 1, |end| end + 1);
                }
            }
            if self.is(j, "mod") && self.tokens.get(j + 1).is_some_and(|t| t.kind == Kind::Ident) {
                let name = self.text(j + 1).to_string();
                if self.is(j + 2, "{") {
                    if let Some(end) = matching(self.tokens, j + 2) {
                        ranges.push((i, end));
                        i = end + 1;
                        continue;
                    }
                } else if self.is(j + 2, ";") {
                    let dir = file.parent().unwrap_or(Path::new(""));
                    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                    let dir = if matches!(stem, "lib" | "main" | "mod") { dir.to_path_buf() } else { dir.join(stem) };
                    tests.insert(dir.join(format!("{name}.rs")));
                    tests.insert(dir.join(&name).join("mod.rs"));
                }
            }
            i = j.max(i + 1);
        }
        ranges
    }

    /// `#[component(..)]` functions whose arguments give them a constant: own `css` or `js`
    /// (not `css = Owner`, a part drawn as its owner), or `view`.
    fn components(&self, skipped: &[(usize, usize)], found: &mut Vec<(String, usize, &'static str)>) {
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
            let mut j = i + 2;
            if self.is(j, "corten") && self.is(j + 1, "::") {
                j += 2;
            } else if self.is(j, "::") && self.is(j + 1, "corten") && self.is(j + 2, "::") {
                j += 3;
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
            if let (Some(has), true) = (has, self.is(k, "fn")) {
                if self.tokens.get(k + 1).is_some_and(|t| t.kind == Kind::Ident) {
                    found.push((self.text(k + 1).to_string(), self.line(k + 1), has));
                }
            }
            i = close + 1;
        }
    }

    /// What a component's arguments (tokens `from..to`) give its constant, if it has one.
    fn constant(&self, from: usize, to: usize) -> Option<&'static str> {
        let mut has = None;
        let mut i = from;
        while i < to {
            let owned = !self.is(i + 1, "=");
            match self.text(i) {
                "css" if owned => has = Some("stylesheet"),
                "js" if owned => has = has.or(Some("script")),
                "view" => has = has.or(Some("view")),
                _ => {}
            }
            // To the next argument.
            while i < to && !self.is(i, ",") {
                i = if self.tokens[i].kind == Kind::Open { matching(self.tokens, i).unwrap_or(i) + 1 } else { i + 1 };
            }
            i += 1;
        }
        has
    }

    /// The names in the crate's lists: the elements of an item typed `[Component]`
    /// (`pub const COMPONENTS: &[Component] = &[Card, ui::Button];`) and of the array a
    /// `components(..)` call is given, by their last path segment.
    fn lists(&self, skipped: &[(usize, usize)], names: &mut BTreeSet<String>) {
        let mut i = 0;
        while i < self.tokens.len() {
            if let Some(&(_, end)) = skipped.iter().find(|(start, _)| *start == i) {
                i = end + 1;
                continue;
            }
            if self.is(i, "components") && self.is(i + 1, "(") {
                if let Some(end) = matching(self.tokens, i + 1) {
                    self.arrays(i + 2, end, names);
                }
            } else if (self.is(i, "const") || self.is(i, "static"))
                && self.tokens.get(i + 1).is_some_and(|t| t.kind == Kind::Ident)
            {
                // `const NAME: <type> = <value>;`
                let mut j = i + 2;
                if self.is(j, ":") {
                    let mut eq = j + 1;
                    let mut component = false;
                    while eq < self.tokens.len() && !self.is(eq, "=") && !self.is(eq, ";") {
                        component |= self.is(eq, "Component");
                        eq += 1;
                    }
                    if component && self.is(eq, "=") {
                        j = eq + 1;
                        let mut end = j;
                        while end < self.tokens.len() && !self.is(end, ";") {
                            end = if self.tokens[end].kind == Kind::Open {
                                matching(self.tokens, end).unwrap_or(end) + 1
                            } else {
                                end + 1
                            };
                        }
                        self.arrays(j, end, names);
                        i = end;
                    }
                }
            }
            i += 1;
        }
    }

    /// The last path segment of each element of every `[..]` between `from` and `to`.
    fn arrays(&self, from: usize, to: usize, names: &mut BTreeSet<String>) {
        let mut i = from;
        while i < to {
            if self.is(i, "[") {
                let end = matching(self.tokens, i).unwrap_or(to);
                let mut last = None;
                for k in i + 1..=end {
                    if self.is(k, ",") || k == end {
                        if let Some(name) = last.take() {
                            names.insert(name);
                        }
                    } else if self.tokens[k].kind == Kind::Ident {
                        last = Some(self.text(k).to_string());
                    }
                }
                i = end + 1;
            } else {
                i += 1;
            }
        }
    }
}

/// Fails, naming each, when a crate `corten check` covers from `dir` has a component no list names.
pub fn check(dir: &Path) -> Result<(), String> {
    let mut lines = Vec::new();
    for root in crate::scripts::app_roots(dir)? {
        for c in unlisted(&root)? {
            let file = c.file.strip_prefix(dir).unwrap_or(&c.file);
            lines.push(format!(
                "{}:{}: {} has a {}, and no list in its crate names it, so a page that draws it fails in a debug build and goes without its {} in a release one: add it to a COMPONENTS list or App::components",
                file.display(),
                c.line,
                c.name,
                c.has,
                c.has
            ));
        }
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

    #[test]
    fn a_component_no_list_names_is_found_and_test_code_is_not_read() {
        let root = std::env::temp_dir().join(format!("corten-listed-{}", std::process::id()));
        let src = root.join("src");
        std::fs::create_dir_all(src.join("parts")).unwrap();
        let write = |path: &str, text: &str| std::fs::write(src.join(path), text).unwrap();
        write(
            "lib.rs",
            r#"mod parts;
#[cfg(test)]
mod tests;
use corten::{prelude::*, Component};

/// #[component(css)] fn InAComment() {}
pub const COMPONENTS: &[Component] = &[Card, parts::Panel];

pub fn app() -> App { App::new(routes()).components(COMPONENTS).components(&[ui::Chart, Live]) }

#[component(css)]
pub fn Card<C: Render>(children: C) -> impl Render { html! { <div class={Card}>{children}</div> } }

#[corten::component(js)]
fn Live() -> impl Render { html! { <p>"live"</p> } }

#[component(css = Card)]
fn CardTitle() -> impl Render { html! { <h2>"part"</h2> } }

#[component]
fn Plain() -> impl Render { html! { <p>"plain"</p> } }

#[cfg(test)]
mod inline {
    #[component(css)]
    fn OnlyInATest() -> impl Render { html! { <p>"t"</p> } }
}
"#,
        );
        write(
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
"#,
        );
        write(
            "tests.rs",
            "#[component(css)]
fn InTheTests() -> impl Render { html! { <p></p> } }
",
        );
        let found = unlisted(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let names: Vec<(&str, usize, &str)> = found.iter().map(|c| (c.name.as_str(), c.line, c.has)).collect();
        assert_eq!(names, [("DialogNotSent", 6, "stylesheet"), ("Row", 11, "view")]);
        assert!(found[0].file.ends_with("parts.rs"));
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
