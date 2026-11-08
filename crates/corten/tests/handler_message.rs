//! Compile errors in Corten's words, checked by building a small app against this crate:
//!
//! 1. A handler a route names that takes an argument no request can fill fails at the handler's
//!    name in `#[route(..)]` and names the argument: before, the error was that axum's `Handler`
//!    is not implemented, with a hint to use `#[axum::debug_handler]`, and named no argument (#761).
//! 2. A value that is not a link where an `Href` is expected says what a link is (#974).
//! 3. An `Option` of a type that is only `Display` in an attribute says what an `Option` takes
//!    there (#1111).
//!
//! Each app is built with `cargo`, offline, from the workspace's lock, in the target directory
//! `link_clash` builds in, so they share the dependencies' builds.

use std::{path::Path, process::Command};

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// The errors `cargo build` prints for an app whose `home` takes `args`.
fn build(args: &str) -> (bool, String) {
    build_main("handler-message", &format!("use corten::prelude::*;\n\n#[corten::routes]\nmod url {{\n    #[route(\"/\", get = home)]\n    pub struct Home;\n}}\n\npub struct Name;\n\n#[allow(unused_variables)]\nasync fn home({args}) -> HtmlResult {{\n    req.redirect(&url::Home)\n}}\n\nfn main() {{\n    let _ = App::new(url::router());\n}}\n"))
}

/// The errors `cargo build` prints for an app in `dir`, a package of that name (so two tests
/// building at once in one target directory do not write each other's binary), whose `main.rs` is
/// `main`.
fn build_main(dir: &str, main: &str) -> (bool, String) {
    let corten = Path::new(env!("CARGO_MANIFEST_DIR")).to_string_lossy().replace('\\', "/");
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(dir);
    write(
        &root.join("Cargo.toml"),
        &format!("[package]\nname = \"{dir}\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\ncorten = {{ package = \"corten-run\", path = \"{corten}\" }}\n\n[workspace]\n"),
    );
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock"), root.join("Cargo.lock")).unwrap();
    write(&root.join("src/main.rs"), main);
    let target = Path::new(env!("CARGO_TARGET_TMPDIR")).join("link-clash-target");
    let out = Command::new(env!("CARGO"))
        .args(["build", "--offline", "-q"])
        .current_dir(&root)
        .env("CARGO_TARGET_DIR", target)
        .env("CARGO_TERM_COLOR", "never")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn a_handler_argument_no_request_fills_is_named_in_cortens_words() {
    // Before the last argument (read from the head) and as the last (which may read the body).
    for args in ["name: Name, req: Req", "req: Req, name: Name"] {
        let (ok, stderr) = build(args);
        assert!(!ok, "a handler taking ({args}) compiled");
        assert!(stderr.contains("cannot serve this route"), "Corten's message for ({args}): {stderr}");
        // The second error names the argument and the trait it lacks: the trait reference only,
        // not rustc's sentence around it, which may change.
        assert!(stderr.contains("Name: FromRequestParts<()>"), "the argument named for ({args}): {stderr}");
        assert!(!stderr.contains("debug_handler"), "no axum hint for ({args}): {stderr}");
    }
    let (ok, stderr) = build("req: Req");
    assert!(ok, "the same app with a handler a request can call: {stderr}");
}

/// A value that is not a link where one is expected says what a link is, and that a boxed route is
/// not one, where before rustc's list of the types that are ended in "and 120 others" (#974).
#[test]
fn a_value_that_is_not_a_link_says_what_a_link_is() {
    let app = |link: &str| {
        format!("use corten::{{prelude::*, Href}};\n\n#[derive(Route)]\n#[route(\"/pull-sheet\")]\nstruct PullSheet;\n\nfn go(_: &dyn Href) {{}}\n\nfn main() {{\n    go(&{link});\n}}\n")
    };
    let (ok, stderr) = build_main("href-message", &app("Box::new(PullSheet)"));
    assert!(!ok, "a boxed route compiled as a link");
    assert!(stderr.contains("`Box<PullSheet>` is not a link"), "Corten's message: {stderr}");
    assert!(stderr.contains("a link is a `#[derive(Route)]` value"), "the note on what a link is: {stderr}");
    assert!(stderr.contains("boxed as `Box<dyn Href>`"), "the note on a boxed route: {stderr}");
    assert!(!stderr.contains(" others"), "no list of every type that is a link: {stderr}");
    let (ok, stderr) = build_main("href-message", &app("\"/pull-sheet\""));
    assert!(!ok, "text compiled as a link");
    assert!(stderr.contains("`Local::parse(text)`"), "the way from text to a link: {stderr}");
    let (ok, stderr) = build_main("href-message", &app("(Box::new(PullSheet) as Box<dyn Href>)"));
    assert!(ok, "the same link boxed as Box<dyn Href>: {stderr}");
}

/// An `Option` of a type that is only `Display` cannot be an attribute's value (`Option<T>` needs
/// `T: AttrValue`), and the error says what it takes; an `Option` of a `UrlValue` enum compiles.
#[test]
fn an_option_in_an_attribute_says_what_it_takes() {
    let app = |value: &str| {
        format!("use corten::prelude::*;

struct Shown;

impl std::fmt::Display for Shown {{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{
        f.write_str(\"shown\")
    }}
}}

#[derive(Clone, Copy, UrlValue)]
enum Finish {{
    Weathered,
}}

fn main() {{
    let _ = (Shown, Finish::Weathered);
    let _ = html! {{ <div data-a={{{value}}}></div> }}.to_html();
}}
")
    };
    let (ok, stderr) = build_main("attr-message", &app("Some(Shown)"));
    assert!(!ok, "an Option of a Display type compiled as an attribute");
    assert!(stderr.contains("this value cannot be written in an attribute"), "Corten's message: {stderr}");
    assert!(stderr.contains("if the value is an `Option`"), "the note on an Option: {stderr}");
    let (ok, stderr) = build_main("attr-message", &app("Some(Finish::Weathered)"));
    assert!(ok, "an Option of a UrlValue enum: {stderr}");
}
