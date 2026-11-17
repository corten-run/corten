//! `corten`: create, run and check Corten apps. Standard library only.
//!
//! - `corten new <dir>` writes a working app (page, form, handler script, test, Dockerfile).
//! - `corten dev` builds and runs the app, rebuilds and restarts it when a file changes (a failed
//!   build keeps the running server), and open pages reload by themselves.
//! - `corten build` builds the release binary. `corten check` runs format, a check that every
//!   styled component is listed, lint, a build of every target and tests, then a type check of
//!   the app's scripts (with TypeScript's `tsc`, which it needs unless told
//!   `--no-script-types`).
//! - `corten fmt` runs `cargo fmt` and lays out the markup in `html!`, which rustfmt leaves alone.
//! - `corten ui` sets up the UI kit and copies its components into the app.

mod dev;
mod fmt;
mod json;
mod listed;
mod new;
mod pin;
mod scripts;
mod ui;

use std::process::{Command, ExitCode};

const HELP: &str = "corten: create, run and check Corten apps

Usage:
  corten new <dir> [--name <crate>] [--corten-path <path>]
                   Create an app in <dir>. --corten-path uses a local checkout (its root or
                   its crates/corten) instead of the crates.io release.
  corten dev [--port <port>]
                   Build and run the app in this directory; rebuild and restart on every
                   change, and reload open pages. Default port 3000.
  corten build     Build the release binary.
  corten fmt [--check] [path ..]
                   cargo fmt, then lay out the markup inside html! (rustfmt leaves macro
                   bodies alone), so it fixes what corten check reports. With paths, only
                   their markup. --check reports what needs it instead of writing it.
  corten check [--no-script-types]
                   Refuse a missing or stale Cargo.lock; corten fmt --check;
                   that every component with a stylesheet, script or
                   view is named in an array (a COMPONENTS list or .components(&[..]));
                   cargo clippy -D warnings; cargo build --all-targets, so what only a
                   binary's main mounts is checked as cargo build checks it; cargo test,
                   then a type check of the scripts in src/ and static/ (TypeScript's tsc, from
                   node_modules or the PATH; an app with scripts fails without it)
                   against the types/app.d.ts the tests wrote. At a workspace root it checks
                   the scripts of each member that uses corten. --no-script-types skips that
                   type check, saying so, on a machine that cannot run tsc.
  corten ui init [--kit-theme]
                   Set up the UI kit: src/ui.rs listing its components, declared as mod ui
                   and listed on the App. An app with a color theme of its own keeps it, and
                   is told which tokens the components read that it lacks; otherwise (or
                   with --kit-theme) it writes the kit's theme tokens (tokens/ui.*.json,
                   light and dark) and the page's colors in static/style.css.
  corten ui add <name>.. [--force] | corten ui add --all [--force]
                   Copy kit components into src/ui/, where they are yours to change, and
                   list them in src/ui.rs. Refuses to replace a file without --force.
  corten ui list   The kit's components.
  corten ui diff [name]..
                   How each copied component differs from this command's kit: whether you
                   edited it, whether the kit changed it since, and the lines. Writes nothing.
  corten help      This text.
  corten --version The version, and the commit the command was built from. dev, fmt and
                   check say when the app's Cargo.lock pins another corten, and how to
                   install the matching command; so does ui, and ui add and
                   ui init refuse to copy this command's kit into it.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `ui` says so itself (`ui::run`), and its `add` and `init` refuse.
    if matches!(args.first().map(String::as_str), Some("dev" | "fmt" | "check"))
        && let Ok(root) = std::env::current_dir()
    {
        pin::warn(&root);
    }
    let result = match args.first().map(String::as_str) {
        None | Some("help" | "-h" | "--help") => {
            print!("{HELP}");
            Ok(())
        }
        Some("-V" | "--version" | "version") => {
            match pin::REV.get(..8) {
                Some(rev) => println!("corten {} ({rev})", env!("CARGO_PKG_VERSION")),
                None => println!("corten {}", env!("CARGO_PKG_VERSION")),
            }
            Ok(())
        }
        Some("new") => new::run(&args[1..]),
        Some("dev") => dev::run(&args[1..]),
        Some("build") => cargo(&["build", "--release"]).map(|()| {
            println!(
                "\ncorten: built the release binary in target/release. It is the whole deploy: the static files are compiled into it (see Dockerfile)."
            );
        }),
        Some("fmt") => fmt::run(&args[1..]),
        Some("ui") => ui::run(&args[1..]),
        Some("check") => check_flags(&args[1..]).and_then(check),
        Some(other) => Err(format!("unknown command {other:?}; run corten help")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("corten: {message}");
            ExitCode::FAILURE
        }
    }
}

/// `corten check`'s flags: whether `--no-script-types` skips the scripts' type check.
fn check_flags(args: &[String]) -> Result<bool, String> {
    match args {
        [] => Ok(false),
        [flag] if flag == "--no-script-types" => Ok(true),
        _ => Err(format!("corten check takes only --no-script-types, not {:?}", args.join(" "))),
    }
}

/// The build `corten check` runs between lint and the tests. It generates the code of every
/// target, each binary's `main` included, so the compiler evaluates a `const` assertion only a
/// `main` reaches, such as a route `main` alone mounts (docs/design.md#limit-caller-types), as
/// `cargo build` does: clippy generates no code, and a binary's test build never generates
/// `main`'s callees. It builds the test targets too, so cargo can compile a binary beside its
/// test build rather than after it. With the default profiles (or a `[profile.test]` that
/// matches `[profile.dev]`) the tests reuse those test targets; a test profile of its own makes
/// the tests compile them again, and bench targets, which `cargo test` does not build, are
/// built here too.
const BUILD: [&str; 3] = ["build", "--all-targets", "--locked"];

/// `corten check`, its scripts' type check skipped with `skip`.
fn check(skip: bool) -> Result<(), String> {
    let root = std::env::current_dir().map_err(|e| e.to_string())?;
    // Resolve with --locked before anything can rewrite the lock. This also settles whether
    // the scripts can be type-checked before format, lint and tests have run.
    let scripts = scripts::plan(&root, skip)?;
    fmt::run(&["--check".to_string()])
        .and_then(|()| listed::check(&root))
        .and_then(|()| lint_build_test(cargo, || scripts::run(scripts)))
}

/// `corten check`'s steps after format and the listed components: each Cargo step run with
/// `run` (lint, then [`BUILD`], then the tests), then the scripts' type check with `scripts`.
/// A failed step stops the ones after it, except that the scripts are checked whatever the tests
/// did.
fn lint_build_test(
    mut run: impl FnMut(&[&str]) -> Result<(), String>,
    scripts: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    run(&["clippy", "--all-targets", "--locked", "--", "-D", "warnings"])?;
    run(&BUILD)?;
    // The tests first: the one that writes `types/app.d.ts` brings it up to date (and fails,
    // saying so, when it was stale) before `tsc` reads it, so a script that uses a new view or
    // event is not refused for a declaration the check had not written yet. The scripts are
    // checked whatever the tests did, so a failing test hides no script error.
    let tests = run(&["test", "--locked"]);
    let scripts = scripts();
    match (tests, scripts) {
        (Ok(()), scripts) => scripts,
        (Err(tests), Ok(())) => Err(tests),
        (Err(tests), Err(scripts)) => Err(format!("{tests}, and {scripts}")),
    }
}

/// Runs `cargo <args>` in the current directory and fails when it does.
fn cargo(args: &[&str]) -> Result<(), String> {
    let status = Command::new("cargo").args(args).status().map_err(|e| format!("could not run cargo: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("cargo {} failed", args.join(" "))) }
}

/// The value after `flag` in `args`, if present.
fn option<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>, String> {
    match args.iter().position(|a| a == flag) {
        Some(i) => args.get(i + 1).map(|v| Some(v.as_str())).ok_or_else(|| format!("{flag} needs a value")),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{check_flags, lint_build_test};
    use std::cell::RefCell;

    #[test]
    fn check_takes_only_the_flag_that_skips_script_types() {
        assert_eq!(check_flags(&[]), Ok(false));
        assert_eq!(check_flags(&["--no-script-types".to_string()]), Ok(true));
        assert!(check_flags(&["--skip".to_string()]).is_err());
        assert!(check_flags(&["--no-script-types".to_string(), "x".to_string()]).is_err());
    }

    /// The steps `lint_build_test` runs when those in `fail` fail, and its result. The scripts'
    /// type check is the step `"script types"`.
    fn steps(fail: &[&str]) -> (Vec<String>, Result<(), String>) {
        let steps = RefCell::new(Vec::new());
        let step = |step: String| {
            let failed = fail.contains(&step.as_str());
            steps.borrow_mut().push(step);
            failed
        };
        let result = lint_build_test(
            |args| if step(args.join(" ")) { Err(format!("cargo {} failed", args.join(" "))) } else { Ok(()) },
            || if step("script types".to_string()) { Err("the scripts failed".to_string()) } else { Ok(()) },
        );
        (steps.into_inner(), result)
    }

    #[test]
    fn the_check_builds_every_target_after_lint_and_before_the_tests() {
        let lint = "clippy --all-targets --locked -- -D warnings";
        let build = "build --all-targets --locked";
        let all = [lint, build, "test --locked", "script types"].map(String::from).to_vec();
        assert_eq!(steps(&[]), (all.clone(), Ok(())));
        // A failed build fails the check before the tests or the scripts run.
        assert_eq!(steps(&[build]), (vec![lint.into(), build.into()], Err("cargo build --all-targets --locked failed".into())));
        // A failed lint stops the build too.
        assert_eq!(steps(&[lint]).0, [lint]);
        // A failed test still has the scripts checked, and both failures are reported.
        assert_eq!(steps(&["test --locked"]), (all.clone(), Err("cargo test --locked failed".into())));
        assert_eq!(
            steps(&["test --locked", "script types"]),
            (all, Err("cargo test --locked failed, and the scripts failed".into()))
        );
    }

    #[test]
    fn the_check_refuses_a_const_assertion_only_a_binarys_main_reaches() {
        // A bin-only crate with the shape of a mount's check (docs/design.md#limit-caller-types):
        // a `const` assertion in a generic function, reached from `main` alone, as a route `main`
        // alone mounts with a `get` that answers a page where the route says `patches`.
        let base = std::env::temp_dir().join(format!("corten-check-bins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("src")).unwrap();
        let manifest = "[package]\nname = \"bin-only\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[workspace]\n";
        std::fs::write(base.join("Cargo.toml"), manifest).unwrap();
        let main = |answer: &str| {
            let main = format!(
                "trait Answer {{ const PATCH: bool; }}\n\
                 struct Page;\nimpl Answer for Page {{ const PATCH: bool = false; }}\n\
                 struct Patch;\nimpl Answer for Patch {{ const PATCH: bool = true; }}\n\
                 fn mount<A: Answer>() {{\n    const {{ assert!(A::PATCH, \"a route that says patches takes a get that answers a patch\") }};\n}}\n\
                 fn main() {{\n    mount::<{answer}>();\n}}\n\
                 #[test]\nfn passes() {{}}\n"
            );
            std::fs::write(base.join("src/main.rs"), main).unwrap();
        };
        // In a target of its own: the one this test runs from is the outer build's.
        let cargo = |args: &[&str]| -> Result<(), String> {
            let out = std::process::Command::new("cargo")
                .args(args)
                .current_dir(&base)
                .env("CARGO_TARGET_DIR", base.join("target"))
                .output()
                .map_err(|e| e.to_string())?;
            if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
        };
        // The check's own steps, clippy left out: it generates no code, so it cannot refuse the
        // crate, and the release job these tests also run in has none.
        let check = || lint_build_test(|args| if args[0] == "clippy" { Ok(()) } else { cargo(args) }, || Ok(()));
        main("Page");
        assert_eq!(cargo(&["test"]), Ok(()), "the tests alone pass it");
        let error = check().expect_err("the check refuses it");
        assert!(error.contains("E0080") && error.contains("takes a get that answers a patch"), "{error}");
        // With a `get` that answers a patch, the same crate passes: the assertion refused it.
        main("Patch");
        let result = check();
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(result, Ok(()));
    }
}
