//! `corten`: create, run and check Corten apps. Standard library only.
//!
//! - `corten new <dir>` writes a working app (page, form, handler script, test, Dockerfile).
//! - `corten dev` builds and runs the app, rebuilds and restarts it when a file changes (a failed
//!   build keeps the running server), and open pages reload by themselves.
//! - `corten build` runs Cargo's release build, with `--profile-from` laid out by a profile of
//!   the app at work, passing a closed list of Cargo's arguments on.
//! - `corten check` runs format, a check that every
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
mod profile;
mod scripts;
mod ui;

use std::io::Write;
use std::process::{Command, ExitCode};

const HELP: &str = "corten: create, run and check Corten apps

Usage:
  corten new <dir> [--name <crate>] [--corten-path <path>]
                   Create an app in <dir>. --corten-path uses a local checkout (its root or
                   its crates/corten) instead of the crates.io release. Writes its
                   Cargo.lock too (cargo update --workspace), which corten check requires.
  corten dev [--port <port>]
                   Build and run the app in this directory; rebuild and restart on every
                   change, and reload open pages. The port is --port's (or --port=<port>),
                   else PORT's, else 3000.
  corten build [<cargo argument> ..] [[--port <port>] --profile-from <command> [<argument> ..]]
                   Run Cargo's release build. Cargo's --features (-F), --all-features,
                   --no-default-features, --locked, --package (-p) and --bin, given before
                   --profile-from, go to each build; any other argument is refused.
                   With --profile-from, build it with a profile of
                   the app at work: build an instrumented copy under target/corten-profile,
                   start it on a free port, run <command> with that port in PORT to send it
                   requests like the ones the app will serve, stop the copy, and build
                   target/release with the profile it wrote. --port <port>, before
                   --profile-from, names the port in place of a free one, for an app that
                   binds a port of its own and does not read PORT (corten build --port 8443
                   --profile-from ..); a PORT in the environment is not read. Needs
                   the toolchain's llvm-profdata (rustup component add llvm-tools) and a
                   Unix system. A failed step leaves target/release as it was.
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
  corten ui add <name>.. [--force | --merge] | corten ui add --all [--force | --merge]
                   Copy kit components into src/ui/, where they are yours to change, and
                   list them in src/ui.rs. Refuses to replace a file without --force, which
                   replaces it, or --merge, which takes the kit's changes and keeps your edits.
  corten ui list   The kit's components.
  corten ui diff [name]..
                   How each copied component differs from this command's kit: whether you
                   edited it, whether the kit changed it since, and the lines. Writes nothing.
  corten help [<command>]
                   This text, or one command's usage (as corten <command> --help).
  corten --version The version, and the commit the command was built from. dev, fmt and
                   check say when the app's Cargo.lock pins another corten, and how to
                   install the matching command; so does ui, and ui add and
                   ui init refuse to copy this command's kit into it.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `corten help <command>` is `corten <command> --help`, and an unknown command is refused.
    // `corten help --help` is help's own help.
    let target: Vec<String> = match args.split_first() {
        Some((first, rest)) if first == "help" => {
            rest.iter().filter(|arg| !matches!(arg.as_str(), "--help" | "-h")).cloned().collect()
        }
        _ => Vec::new(),
    };
    if !target.is_empty() {
        let asked: Vec<String> = target.iter().cloned().chain(["--help".to_string()]).collect();
        return match command_help(&asked) {
            Some(help) => {
                print!("Usage:\n{help}");
                ExitCode::SUCCESS
            }
            None => {
                eprintln!("corten: no command {:?}; run corten help", target.join(" "));
                ExitCode::FAILURE
            }
        };
    }
    if let Some(help) = command_help(&args) {
        print!("Usage:\n{help}");
        return ExitCode::SUCCESS;
    }
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
        Some("dev") => dev_flags(&args[1..]).and_then(dev::run),
        Some("build") => build_flags(&args[1..]).and_then(|build| match build.profile_from {
            Some(command) => profile::run(command, &build.cargo, build.port),
            None => cargo(&["build", "--release"].into_iter().chain(build.cargo.iter().map(String::as_str)).collect::<Vec<_>>()).map(|()| {
                println!(
                    "\ncorten: the release build finished. An app binary it built (in target/release unless Cargo's configuration moves it) is the whole deploy: the static files are compiled into it (see Dockerfile)."
                );
            }),
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

/// Reuse the command's sections of the full help, before any app inspection or work.
fn command_help(args: &[String]) -> Option<String> {
    let command = args.first()?;
    if !asks_help(command, &args[1..]) {
        return None;
    }
    let name = match command.as_str() {
        "new" | "dev" | "build" | "fmt" | "check" | "help" => command.clone(),
        "version" | "--version" | "-V" => "--version".into(),
        "ui" => match args.get(1).map(String::as_str) {
            Some(sub @ ("init" | "add" | "list" | "diff")) => format!("ui {sub}"),
            Some("--help" | "-h") => "ui".into(),
            _ => return None,
        },
        _ => return None,
    };
    let prefix = format!("{name} ");
    Some(
        HELP.split("\n  corten ")
            .skip(1)
            .filter(|section| section.starts_with(&prefix))
            .map(|section| format!("  corten {section}\n"))
            .collect(),
    )
}

/// Whether `--help` or `-h` stands in a flag position of `command`'s arguments: not as the
/// value of an option of that command that takes one (`new --corten-path --help` names a directory,
/// `ui add --port --help` asks for help). No command reads `--` as the end of its options, so
/// neither does this: the command would still read a flag after it. `build` is read with its own
/// grammar ([`build_asks_help`]), which refuses `--`.
fn asks_help(command: &str, args: &[String]) -> bool {
    match command {
        "build" => return build_asks_help(args),
        "dev" => return dev_asks_help(args),
        _ => {}
    }
    let takes_value: &[&str] = match command {
        "new" => &["--name", "--corten-path"],
        _ => &[],
    };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => return true,
            option if takes_value.contains(&option) => {
                args.next();
            }
            _ => {}
        }
    }
    false
}

/// [`asks_help`] for `corten build`, read with [`build_flags`]'s grammar: help stands before
/// `--profile-from` (everything after it is the command's) in a flag position, or as the
/// missing value of an option (`--bin --help`, `--port --help`). A token `build_flags` would
/// refuse ends the scan, so `--profile-form sh -h`, `--bin --profile-from sh -h` and
/// `--port http -h` are refused for what is wrong with them, not taken for help the command
/// after them was given.
fn build_asks_help(args: &[String]) -> bool {
    let mut args = args.iter();
    let mut port_named = false;
    while let Some(arg) = args.next() {
        // The value an option of build's was given in the same token, or `None` for the next.
        let joined = match (arg.as_str(), port_arg(arg), cargo_arg(arg)) {
            ("--help" | "-h", ..) => return true,
            ("--profile-from", ..) => return false,
            (_, Some(joined), _) => joined,
            (_, None, Some((_, true, false))) => None,
            (_, None, Some(_)) => continue,
            (_, None, None) => return false,
        };
        let value = match joined {
            Some(value) => value,
            None => match args.next().map(String::as_str) {
                Some("--help" | "-h") => return true,
                Some(value) if !value.starts_with('-') => value,
                _ => return false,
            },
        };
        if port_arg(arg).is_some() && (std::mem::replace(&mut port_named, true) || port_number(value).is_err()) {
            return false;
        }
    }
    false
}

/// [`asks_help`] for `corten dev`, read with [`dev_flags`]'s grammar, as [`build_asks_help`] reads
/// build's: help in a flag position or as `--port`'s missing value (`--port --help`), and never
/// after a token `dev_flags` refuses (`--prot 4000 -h`, `--port http -h`, a second `--port` with a value).
fn dev_asks_help(args: &[String]) -> bool {
    let mut args = args.iter();
    let mut port_named = false;
    while let Some(arg) = args.next() {
        let value = match (arg.as_str(), port_arg(arg)) {
            ("--help" | "-h", _) => return true,
            (_, Some(Some(value))) => value,
            (_, Some(None)) => match args.next().map(String::as_str) {
                Some("--help" | "-h") => return true,
                Some(value) if !value.starts_with('-') => value,
                _ => return false,
            },
            (_, None) => return false,
        };
        if std::mem::replace(&mut port_named, true) || port_number(value).is_err() {
            return false;
        }
    }
    false
}

/// `--port`'s value when `arg` is that option: what follows `=` in the same token, or `None`
/// when the value is the next one.
fn port_arg(arg: &str) -> Option<Option<&str>> {
    match arg.strip_prefix("--port")? {
        "" => Some(None),
        rest => rest.strip_prefix('=').map(Some),
    }
}

/// Reads `--port` when `arg`, the argument before `args[*at]`, is that option: its value after
/// it (moving `at` past it) or after `=`, once, a port number ([`port_number`]). `false` when
/// `arg` is another argument. `corten build` and `corten dev` read the flag with it, so the two
/// take the same spellings and refuse the same values.
fn read_port(arg: &str, args: &[String], at: &mut usize, port: &mut Option<u16>) -> Result<bool, String> {
    let Some(joined) = port_arg(arg) else { return Ok(false) };
    let value = match (joined, args.get(*at)) {
        (Some(value), _) => value,
        (None, Some(value)) if !value.starts_with('-') => {
            *at += 1;
            value.as_str()
        }
        (None, _) => return Err("--port needs a value".into()),
    };
    if port.replace(port_number(value)?).is_some() {
        return Err("--port is given more than once".into());
    }
    Ok(true)
}

/// `corten dev`'s flags: `--port` alone, read as `corten build` reads it ([`read_port`]). Any
/// other argument is refused, so a misspelled flag does not start the app on the default port.
fn dev_flags(args: &[String]) -> Result<Option<u16>, String> {
    let mut port = None;
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        at += 1;
        if !read_port(arg, args, &mut at, &mut port)? {
            return Err(format!("corten dev takes --port <port> (or --port=<port>); not {arg:?}"));
        }
    }
    Ok(port)
}

/// The port `--port` names: digits that make a number from 1 to 65535. 0 names no port to look
/// for the app on, and a sign or a space is not how a port is written.
fn port_number(value: &str) -> Result<u16, String> {
    match value.parse::<u16>() {
        Ok(port) if port != 0 && value.bytes().all(|byte| byte.is_ascii_digit()) => Ok(port),
        _ => Err(format!("--port takes the number of the port the app binds, from 1 to 65535; not {value:?}")),
    }
}

/// The [`CARGO_ARGS`] entry `arg` is: its name, whether it takes a value, and whether the value
/// is in the same token (after `=`, or joined to a short flag).
fn cargo_arg(arg: &str) -> Option<(&'static str, bool, bool)> {
    CARGO_ARGS.iter().find_map(|&(name, value)| {
        let rest = arg.strip_prefix(name)?;
        match rest {
            "" => Some((name, value, false)),
            _ if value && rest.starts_with('=') => Some((name, value, true)),
            _ if value && !name.starts_with("--") => Some((name, value, true)),
            _ => None,
        }
    })
}

/// The Cargo arguments `corten build` passes on to each build it runs, and whether each takes a
/// value. A closed list: an argument that moves the build's output (`--target-dir`, `--profile`,
/// `--target`) or its messages would break the profiled build's steps, which read both.
const CARGO_ARGS: [(&str, bool); 8] = [
    ("--features", true),
    ("-F", true),
    ("--all-features", false),
    ("--no-default-features", false),
    ("--locked", false),
    ("--package", true),
    ("-p", true),
    ("--bin", true),
];

/// What `corten build` was asked for.
#[derive(Debug, PartialEq)]
struct Build<'a> {
    /// The Cargo arguments, each value its own item, given to every build in their order.
    cargo: Vec<String>,
    /// The port `--port` names, where a profiled build looks for the app in place of a free one.
    port: Option<u16>,
    /// The command after `--profile-from`, with its arguments, if any.
    profile_from: Option<&'a [String]>,
}

/// `corten build`'s flags: the [`CARGO_ARGS`] before `--profile-from`, then the command after
/// it. Each is passed to Cargo as it was written: a value after its flag (`--features a`), after
/// `=` (`--features=a`, `-F=a`) or, for a short flag, joined to it (`-Fa`), empty included
/// (`--features ""`, which a CI variable may be). Anything else is refused, so a misspelled flag
/// is not an ordinary build that looks profiled, and a value cannot read as a flag, so
/// `--bin --profile-from sh` does not take `--profile-from` for a binary's name.
///
/// `--port` is the profiled build's own, among them in any place: its value after it or after
/// `=`, once, a port number ([`port_number`]). It is refused without `--profile-from`, where
/// nothing is started that a port could be looked for on.
fn build_flags(args: &[String]) -> Result<Build<'_>, String> {
    let mut cargo = Vec::new();
    let mut port = None;
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        at += 1;
        if arg == "--profile-from" {
            let command = &args[at..];
            if command.is_empty() {
                return Err("--profile-from needs a command".into());
            }
            return Ok(Build { cargo, port, profile_from: Some(command) });
        }
        if read_port(arg, args, &mut at, &mut port)? {
            continue;
        }
        match cargo_arg(arg) {
            Some((_, false, _)) | Some((_, true, true)) => cargo.push(arg.clone()),
            Some((name, true, false)) => match args.get(at) {
                Some(value) if !value.starts_with('-') => {
                    at += 1;
                    cargo.extend([arg.clone(), value.clone()]);
                }
                _ => return Err(format!("{name} needs a value")),
            },
            None => {
                let list: Vec<&str> = CARGO_ARGS.iter().map(|(name, _)| *name).collect();
                return Err(format!(
                    "corten build takes {} for Cargo and --port <port> for a profiled build, then --profile-from <command>; not {arg:?}",
                    list.join(", ")
                ));
            }
        }
    }
    match port {
        Some(port) => Err(format!(
            "--port {port} names the port a profiled build looks for the app on, and there is no --profile-from: corten build without it starts no app"
        )),
        None => Ok(Build { cargo, port: None, profile_from: None }),
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
    let scripts = check_step("script type setup", || scripts::plan(&root, skip))?;
    check_step("corten fmt --check", || fmt::run(&["--check".to_string()]))
        .and_then(|()| check_step("listed components", || listed::check(&root)))
        .and_then(|()| {
            lint_build_test(
                |args| check_step(&format!("cargo {}", args.join(" ")), || cargo(args)),
                || check_step("script types", || scripts::run(scripts)),
            )
        })
}

/// Cargo's output is inherited already. Name even a silent or cached step in redirected logs.
fn check_step<T>(name: &str, run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    // Progress only: a closed stderr must not stop a step or lose its result.
    let _ = writeln!(std::io::stderr(), "corten check: {name}");
    let start = std::time::Instant::now();
    let result = run();
    let outcome = if result.is_ok() { "finished in" } else { "failed after" };
    let _ = writeln!(std::io::stderr(), "corten check: {name} {outcome} {:.2}s", start.elapsed().as_secs_f64());
    result
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

/// The value after `flag` in `args`, if present. The token after `flag` is its value even when it
/// reads as `flag` again. A flag given twice is refused, so the value a command runs with is the one
/// [`asks_help`] reads past (`--name a --name --help` is not help).
fn option<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>, String> {
    let mut found = None;
    let mut at = 0;
    while at < args.len() {
        if args[at] != flag {
            at += 1;
            continue;
        }
        if found.is_some() {
            return Err(format!("{flag} is given more than once"));
        }
        found = Some(args.get(at + 1).ok_or_else(|| format!("{flag} needs a value"))?.as_str());
        at += 2;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::{Build, asks_help, build_flags, check_flags, dev_flags, lint_build_test, option};
    use std::cell::RefCell;

    #[test]
    fn help_is_asked_only_in_a_flag_position() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(asks_help("new", &args(&["app", "--help"])));
        assert!(asks_help("new", &args(&["app", "--name", "shop", "-h"])));
        assert!(!asks_help("new", &args(&["app", "--corten-path", "--help"])));
        assert!(!asks_help("new", &args(&["app", "--name", "-h"])));
        // dev reads `--port` as build does: a value never starts with `-`, so help in its place is
        // help, and a token dev refuses ends the scan.
        assert!(asks_help("dev", &args(&["--port", "--help"])));
        assert!(asks_help("dev", &args(&["--port=4000", "-h"])));
        assert!(asks_help("dev", &args(&["--port", "4000", "--help"])));
        assert!(!asks_help("dev", &args(&["--prot", "4000", "-h"])));
        assert!(!asks_help("dev", &args(&["--port", "http", "-h"])));
        assert!(!asks_help("dev", &args(&["--port", "4000", "--port=5000", "-h"])));
        // A second `--port` stops the scan only with a value: help in its place is still help.
        assert!(asks_help("dev", &args(&["--port", "4000", "--port", "--help"])));
        // `--` ends no command's options, so it ends no scan for help either.
        assert!(asks_help("new", &args(&["app", "--", "--help"])));
        // An option names a value only for the command that has it, and a `--` it takes is a value.
        assert!(asks_help("ui", &args(&["add", "--all", "--port", "--help"])));
        assert!(asks_help("new", &args(&["shop", "--corten-path", "--", "--help"])));
        // What follows `--profile-from` is the command it runs, with that command's own flags.
        assert!(asks_help("build", &args(&["--help", "--profile-from", "./train.sh"])));
        assert!(!asks_help("build", &args(&["--profile-from", "./train.sh", "--help"])));
        assert!(!asks_help("build", &args(&["--profile-from", "--help"])));
        assert!(!asks_help("dev", &args(&["--profile-from", "--help"])));
        // A Cargo argument's value is a value, and one that reads as a flag is not.
        assert!(asks_help("build", &args(&["--bin", "web", "-h"])));
        assert!(asks_help("build", &args(&["--bin", "--help"])));
        assert!(asks_help("build", &args(&["--locked", "--help"])));
        assert!(!asks_help("build", &args(&["--bin", "--profile-from", "sh", "-h"])));
        assert!(!asks_help("build", &args(&["--features", "", "--profile-from", "sh", "-h"])));
        // A token build refuses ends the scan: a misspelled flag, a missing value.
        assert!(!asks_help("build", &args(&["-p", "shop", "--profile-form", "sh", "-h"])));
        assert!(!asks_help("build", &args(&["--bin", "--locked", "-h"])));
        assert!(asks_help("build", &args(&["-Fa", "--locked", "-p", "shop", "-h"])));
        // `--port` is build's own, read the same way: help after it, in place of its value, and
        // never after a value or a repeat that build refuses.
        assert!(asks_help("build", &args(&["--port", "8443", "-h"])));
        assert!(asks_help("build", &args(&["--port=8443", "--locked", "--help"])));
        assert!(asks_help("build", &args(&["--port", "--help"])));
        assert!(!asks_help("build", &args(&["--port", "http", "-h"])));
        assert!(!asks_help("build", &args(&["--port=0", "-h"])));
        assert!(!asks_help("build", &args(&["--port", "8443", "--port", "8444", "-h"])));
        assert!(!asks_help("build", &args(&["--port", "8443", "--profile-from", "sh", "-h"])));
        assert!(!asks_help("build", &args(&["--ports", "8443", "-h"])));
    }

    #[test]
    fn dev_reads_its_port_as_build_does_and_refuses_what_it_does_not_take() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(dev_flags(&[]), Ok(None));
        // Both spellings, as build takes them.
        assert_eq!(dev_flags(&args(&["--port", "4000"])), Ok(Some(4000)));
        assert_eq!(dev_flags(&args(&["--port=4000"])), Ok(Some(4000)));
        // What is no port number is refused, where it reached the app as PORT before.
        for no_port in ["", "0", "http", "65536", "+4000", "4000.0"] {
            let says = format!("--port takes the number of the port the app binds, from 1 to 65535; not {no_port:?}");
            assert_eq!(dev_flags(&args(&[format!("--port={no_port}").as_str()])), Err(says.clone()));
            assert_eq!(dev_flags(&args(&["--port", no_port])), Err(says));
        }
        assert_eq!(dev_flags(&args(&["--port"])), Err("--port needs a value".into()));
        assert_eq!(dev_flags(&args(&["--port", "-1"])), Err("--port needs a value".into()));
        assert_eq!(dev_flags(&args(&["--port", "4000", "--port=4001"])), Err("--port is given more than once".into()));
        // A misspelled flag or a stray argument no longer starts the app on the default port.
        for stray in [&["--prot", "4000"][..], &["4000"], &["--port", "4000", "--release"], &["--ports=4000"]] {
            let refused = dev_flags(&args(stray)).unwrap_err();
            assert!(refused.starts_with("corten dev takes --port <port> (or --port=<port>); not "), "{refused}");
        }
    }

    #[test]
    fn build_takes_the_port_a_profiled_build_looks_for_the_app_on() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        // After the flag or after `=`, among the Cargo arguments in any place, and never one of them.
        for written in [
            &["--port", "8443", "--locked", "--profile-from", "sh", "--port", "1"][..],
            &["--port=8443", "--locked", "--profile-from", "sh", "--port", "1"],
            &["--locked", "--port", "8443", "--profile-from", "sh", "--port", "1"],
            // Digits are a number however many zeros lead it.
            &["--locked", "--port=08443", "--profile-from", "sh", "--port", "1"],
        ] {
            let written = args(written);
            let command = &written[written.len() - 3..];
            assert_eq!(
                build_flags(&written),
                Ok(Build { cargo: args(&["--locked"]), port: Some(8443), profile_from: Some(command) }),
                "{written:?}"
            );
        }
        assert_eq!(build_flags(&args(&["--port", "65535", "--profile-from", "sh"])).map(|build| build.port), Ok(Some(65535)));
        // What is no port number is refused as it is read, 0 and a sign included.
        for no_port in ["", "0", "http", "65536", "+8443", "-1", " 8443", "8443 ", "8443.0"] {
            let says = format!("--port takes the number of the port the app binds, from 1 to 65535; not {no_port:?}");
            let joined = args(&[format!("--port={no_port}").as_str(), "--profile-from", "sh"]);
            assert_eq!(build_flags(&joined).unwrap_err(), says);
            // After the flag, a value that reads as a flag is a missing value, as Cargo's are.
            let says = if no_port.starts_with('-') { "--port needs a value".to_string() } else { says };
            assert_eq!(build_flags(&args(&["--port", no_port, "--profile-from", "sh"])).unwrap_err(), says);
        }
        for missing in [&["--port"][..], &["--port", "--profile-from", "sh"], &["--locked", "--port", "--locked"]] {
            assert_eq!(build_flags(&args(missing)), Err("--port needs a value".into()), "{missing:?}");
        }
        let twice = args(&["--port", "8443", "--port=8443", "--profile-from", "sh"]);
        assert_eq!(build_flags(&twice), Err("--port is given more than once".into()));
        // Without a profile no app is started, so a port means nothing and is not passed over.
        for alone in [&["--port", "8443"][..], &["--port=8443", "--locked"]] {
            let refused = build_flags(&args(alone)).unwrap_err();
            assert!(refused.starts_with("--port 8443 names the port a profiled build looks for the app on"), "{refused}");
            assert!(refused.contains("there is no --profile-from"), "{refused}");
        }
        // Another flag that begins the same way is not this one.
        assert!(build_flags(&args(&["--ports", "8443"])).is_err_and(|error| error.starts_with("corten build takes")));
    }

    #[test]
    fn build_takes_only_the_command_a_profile_comes_from() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(build_flags(&[]), Ok(Build { cargo: vec![], port: None, profile_from: None }));
        let command = args(&["--profile-from", "sh", "train.sh", "--profile-from"]);
        assert_eq!(build_flags(&command), Ok(Build { cargo: vec![], port: None, profile_from: Some(&command[1..]) }));
        assert_eq!(build_flags(&args(&["--profile-from"])), Err("--profile-from needs a command".into()));
        // A misspelled flag is refused, not built without a profile.
        assert!(build_flags(&args(&["--profile-form", "sh"])).is_err());
        assert!(build_flags(&args(&["--release"])).is_err());
    }

    #[test]
    fn build_passes_on_the_cargo_arguments_it_lists_before_the_command() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let given = args(&[
            "--no-default-features",
            "--features=a,b",
            "-F",
            "c",
            "--locked",
            "-p",
            "shop",
            "--bin",
            "web",
            "--profile-from",
            "sh",
            "--locked",
        ]);
        // Passed as written, in order; an argument after the command's name is the command's.
        let cargo = given[..9].to_vec();
        assert_eq!(build_flags(&given), Ok(Build { cargo: cargo.clone(), port: None, profile_from: Some(&given[10..]) }));
        assert_eq!(build_flags(&given[..9]), Ok(Build { cargo, port: None, profile_from: None }));
        // Cargo's other spellings of a value, an empty one included.
        for written in [
            &["-Fa"][..],
            &["-F=a"],
            &["-pshop"],
            &["--package", "shop"],
            &["--package=shop"],
            &["--all-features"],
            &["--features="],
            &["--features", ""],
            &["--bin=web"],
        ] {
            let written = args(written);
            assert_eq!(build_flags(&written), Ok(Build { cargo: written.clone(), port: None, profile_from: None }));
        }
        // A value is not a flag, and not missing.
        for refused in [&["--bin", "--profile-from", "sh"][..], &["--features"], &["-p", "-F", "a"]] {
            assert!(build_flags(&args(refused)).is_err_and(|error| error.ends_with("needs a value")), "{refused:?}");
        }
        // What would move the build's output, or is not on the list, is refused.
        for refused in
            [&["--target", "x86_64-unknown-linux-musl"][..], &["--target-dir", "t"], &["--locked=yes"], &["--binary", "x"]]
        {
            assert!(build_flags(&args(refused)).is_err_and(|error| error.starts_with("corten build takes")), "{refused:?}");
        }
    }

    #[test]
    fn an_option_reads_the_token_after_it_and_is_given_once() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(option(&args(&["shop", "--name", "store"]), "--name"), Ok(Some("store")));
        // The second `--corten-path` is the first one's value, a directory, not a repeat.
        assert_eq!(option(&args(&["shop", "--corten-path", "--corten-path"]), "--corten-path"), Ok(Some("--corten-path")));
        assert!(option(&args(&["shop", "--name", "a", "--name", "b"]), "--name").is_err());
        assert!(option(&args(&["shop", "--name"]), "--name").is_err());
        assert_eq!(option(&args(&["shop"]), "--name"), Ok(None));
    }

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
