//! A handler a route names that takes an argument no request can fill fails to compile in
//! Corten's words, at the handler's name in `#[route(..)]`, and names the argument: before, the
//! error was that axum's `Handler` is not implemented, with a hint to use `#[axum::debug_handler]`,
//! and named no argument (#761).
//!
//! It builds a small app against this crate with `cargo`, offline, from the workspace's lock, in
//! the target directory `link_clash` builds in, so the two share the dependencies' builds.

use std::{path::Path, process::Command};

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// The errors `cargo build` prints for an app whose `home` takes `args`.
fn build(args: &str) -> (bool, String) {
    let corten = Path::new(env!("CARGO_MANIFEST_DIR")).to_string_lossy().replace('\\', "/");
    let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("handler-message");
    write(
        &root.join("Cargo.toml"),
        &format!("[package]\nname = \"app\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[dependencies]\ncorten = {{ package = \"corten-run\", path = \"{corten}\" }}\n\n[workspace]\n"),
    );
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock"), root.join("Cargo.lock")).unwrap();
    write(
        &root.join("src/main.rs"),
        &format!("use corten::prelude::*;\n\n#[corten::routes]\nmod url {{\n    #[route(\"/\", get = home)]\n    pub struct Home;\n}}\n\npub struct Name;\n\n#[allow(unused_variables)]\nasync fn home({args}) -> HtmlResult {{\n    req.redirect(&url::Home)\n}}\n\nfn main() {{\n    let _ = App::new(url::router());\n}}\n"),
    );
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
    for (args, bound) in [("name: Name, req: Req", "FromRequestParts<()>"), ("req: Req, name: Name", "FromRequest<()")] {
        let (ok, stderr) = build(args);
        assert!(!ok, "a handler taking ({args}) compiled");
        assert!(stderr.contains("cannot serve this route"), "Corten's message for ({args}): {stderr}");
        // The second error names the argument and the trait it lacks, in rustc's words, which may
        // change: only the type and the trait are checked.
        assert!(stderr.contains("Name") && stderr.contains(bound), "the argument named for ({args}): {stderr}");
        assert!(!stderr.contains("debug_handler"), "no axum hint for ({args}): {stderr}");
    }
    let (ok, stderr) = build("req: Req");
    assert!(ok, "the same app with a handler a request can call: {stderr}");
}
