//! The seam exhibit's evidence: this site's own source with one line changed, and what
//! `cargo build` printed for it. Each verdict is from a real build of this crate; where a build
//! said more than its first error, a line of `...` marks what was left out. Line numbers are
//! the file's when it was broken.
use crate::seam::Cut;

pub const CUTS: [Cut; 5] = [
    Cut {
        label: "Declare a route with no handler",
        file: "src/lib.rs",
        broken: r#"#[route("/certificate", get = certificate)]
pub struct Certificate;
"#,
        verdict: r#"error[E0425]: cannot find value `certificate` in this scope
  --> examples/corten-site/src/lib.rs:67:35
   |
67 |     #[route("/certificate", get = certificate)]
   |                                   ^^^^^^^^^^^ not found in this scope

For more information about this error, try `rustc --explain E0425`.
error: could not compile `corten-site` (lib) due to 1 previous error
"#,
    },
    Cut {
        label: "Misspell a form field",
        file: "src/seam.rs",
        broken: r#"<input
    name={f.nmae}
    class={Input}
    required
"#,
        verdict: r#"error[E0609]: no field `nmae` on type `StrikeFormFields`
   --> examples/corten-site/src/seam.rs:191:33
    |
191 |                         name={f.nmae}
    |                                 ^^^^ unknown field
    |
help: a field with a similar name exists
    |
191 -                         name={f.nmae}
191 +                         name={f.name}
    |

For more information about this error, try `rustc --explain E0609`.
error: could not compile `corten-site` (lib) due to 1 previous error
"#,
    },
    Cut {
        label: "Write a class as a string",
        file: "src/seam.rs",
        broken: r#"<div class="press">
"#,
        verdict: r#"error: "press" is a class of press.css: write class={Press}, which is scoped to this component
   --> examples/corten-site/src/seam.rs:181:20
    |
181 |         <div class="press">
    |                    ^^^^^^^
...
error: could not compile `corten-site` (lib) due to 1 previous error; 1 warning emitted
"#,
    },
    Cut {
        label: "Hand a handler the wrong element",
        file: "src/surface.rs",
        broken: r#"on:click={js::order(event, readout, grid, ordered, number)}
"#,
        verdict: r#"error[E0277]: the handler takes an HTMLDivElement, and this is an HTMLOutputElement
    --> examples/corten-site/src/surface.rs:183:48
     |
 183 |                     on:click={js::order(event, readout, grid, ordered, number)}
     |                               ---------        ^^^^^^^ an HTMLOutputElement, from the tag its ref is on
     |                               |
     |                               required by a bound introduced by this call
     |
     = help: the trait `corten::script::el::SubOf<HTMLDivElement>` is not implemented for `HTMLOutputElement`
     = note: put the ref on an element the handler takes, or widen the JSDoc type (HTMLElement takes any HTML element)
...
error: could not compile `corten-site` (lib) due to 4 previous errors
"#,
    },
    Cut {
        label: "Send a patch with no id",
        file: "src/seam.rs",
        broken: r#"#[component(css, js)]
pub fn Nameplate<'a>(plate: &'a Plate<'a>, patched: bool) -> impl Patch {
    let struck = refs();
    html! {
        <div class={Nameplate}>
"#,
        verdict: r#"error[E0277]: this view is not a patch: one of its top-level parts is not an element with a #[derive(Id)] id
    --> examples/corten-site/src/seam.rs:215:1
     |
 215 | #[component(css, js)]
     | ^^^^^^^^^^^^^^^^^^^^^ a patch replaces elements by id
     |
     = help: the trait `corten::view::__private::PatchShape` is not implemented for `corten::view::__private::TextOrElementWithoutId`
...
error: could not compile `corten-site` (lib) due to 1 previous error
"#,
    },
];

#[cfg(test)]
mod tests {
    use super::CUTS;

    /// What each break did to its file: the text that was there, and what the build was given.
    const BREAKS: [(&str, &str); 5] = [
        ("pub mod url {\n", "pub mod url {\n    #[route(\"/certificate\", get = certificate)]\n    pub struct Certificate;\n"),
        ("name={f.name}", "name={f.nmae}"),
        ("<div class={Press}>", "<div class=\"press\">"),
        ("js::order(event, grid, readout, ordered, number)", "js::order(event, readout, grid, ordered, number)"),
        ("<div id={NameplateId} class={Nameplate}>", "<div class={Nameplate}>"),
    ];

    fn source(file: &str) -> &'static str {
        match file {
            "src/lib.rs" => include_str!("lib.rs"),
            "src/seam.rs" => include_str!("seam.rs"),
            "src/surface.rs" => include_str!("surface.rs"),
            other => panic!("no break is recorded in {other}"),
        }
    }

    /// Each answer is for the source as it is. Break the file as recorded, and the line the
    /// compiler cites is the line it quotes, and what the page shows as broken is in it. An edit
    /// that moves a cited line fails here until the answer is captured again (README.md, Kept
    /// true): `cargo build -p corten-site` from the repository's root, with the one change made.
    #[test]
    fn each_answer_is_for_the_source_as_it_is() {
        for (cut, (whole, broken)) in CUTS.iter().zip(BREAKS) {
            let source = source(cut.file);
            assert_eq!(source.matches(whole).count(), 1, "{}: the source has this once: {whole}", cut.label);
            let given = source.replace(whole, broken);
            let at = format!("--> examples/corten-site/{}:", cut.file);
            let cited = cut.verdict.split_once(&at).unwrap_or_else(|| panic!("{}: the answer cites no {at}", cut.label)).1;
            let line: usize = cited.split(':').next().and_then(|line| line.parse().ok()).expect("a line number");
            let quoted = cut.verdict.lines().find_map(|text| text.trim_start().strip_prefix(&format!("{line} |")));
            let quoted = quoted.unwrap_or_else(|| panic!("{}: the answer does not quote line {line}", cut.label));
            let there = given.lines().nth(line - 1).unwrap_or_default();
            assert_eq!(quoted.trim(), there.trim(), "{}: line {line} is no longer the line the compiler quoted", cut.label);
            for shown in cut.broken.lines() {
                assert!(given.contains(shown.trim()), "{}: the page shows a line the broken file lacks: {shown}", cut.label);
            }
        }
    }
}
