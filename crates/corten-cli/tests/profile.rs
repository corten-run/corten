//! `corten build --profile-from <command>`, run for real on a small program that listens and
//! stops as an app does. The toolchain's llvm-profdata must be installed
//! (`rustup component add llvm-tools`). Unix only, as the option is: it stops the app with
//! SIGTERM.
#![cfg(unix)]

use std::{
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

/// A program that listens on `PORT` (at `HOST`, when that is set), works while it waits, and
/// returns from `main` on SIGTERM, as a Corten app does. It writes its process id to `pid.txt`
/// and, as it leaves, `stopped.txt`. Three variables change it:
/// `FIXTURE_EXITS_AT_ONCE` (it never listens), `FIXTURE_QUITS_WITHOUT_A_PROFILE` (on SIGTERM
/// it leaves without running what writes a profile, as a killed app does) and
/// `FIXTURE_LISTENS_ON` (a port of its own, as an app that binds its own listeners has: it then
/// never reads `PORT`).
const MAIN: &str = r#"use std::sync::atomic::{AtomicBool, Ordering};

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn stop(_signal: i32) {
    STOP.store(true, Ordering::SeqCst);
}

unsafe extern "C" {
    fn signal(signal: i32, handler: extern "C" fn(i32)) -> usize;
    fn _exit(code: i32) -> !;
}

fn work(n: u64) -> u64 {
    if n % 3 == 0 { n * 2 } else { n + 1 }
}

fn main() {
    std::fs::write("pid.txt", std::process::id().to_string()).unwrap();
    if std::env::var_os("FIXTURE_EXITS_AT_ONCE").is_some() {
        std::process::exit(7);
    }
    unsafe { signal(15, stop) };
    let port = std::env::var("FIXTURE_LISTENS_ON").unwrap_or_else(|_| std::env::var("PORT").expect("PORT"));
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = std::net::TcpListener::bind(format!("{host}:{port}")).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut sum = 0u64;
    while !STOP.load(Ordering::SeqCst) {
        let _ = listener.accept();
        sum = (0..1000).fold(sum, |sum, n| sum.wrapping_add(work(n)));
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    std::fs::write("stopped.txt", "").unwrap();
    if std::env::var_os("FIXTURE_QUITS_WITHOUT_A_PROFILE").is_some() {
        unsafe { _exit(0) };
    }
    println!("{sum}");
}
"#;

struct Fixture(PathBuf);

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("corten-profile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        // As the command names it, where the temporary directory is a link.
        let root = std::fs::canonicalize(&root).unwrap();
        let manifest = "[package]\nname = \"profiled\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[workspace]\n";
        std::fs::write(root.join("Cargo.toml"), manifest).unwrap();
        std::fs::write(root.join("src/main.rs"), MAIN).unwrap();
        // A build script, which the instrumented build instruments too: it writes a profile of
        // its own as it runs, which is not the app's.
        std::fs::write(root.join("build.rs"), "fn main() {\n    println!(\"cargo::rerun-if-changed=build.rs\");\n}\n").unwrap();
        Self(root)
    }

    /// `corten build <args>` in the program's directory, with a target directory of its own
    /// and none of the flags of whoever runs the tests: an empty `RUSTFLAGS` has Cargo read
    /// none from a configuration file either. Dep-info files name paths relative to the
    /// program's directory, whatever base a configuration file sets. Cargo says what it
    /// compiles, in plain text, which a test reads. Nor the `PORT` of whoever runs the tests:
    /// the build picks a port unless a test gives it one.
    fn build(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_corten"));
        command.arg("build").args(args).current_dir(&self.0).env("CARGO_TARGET_DIR", self.0.join("target"));
        command.env_remove("PORT");
        command.env_remove("CARGO_ENCODED_RUSTFLAGS").env("RUSTFLAGS", "").env("CARGO_BUILD_DEP_INFO_BASEDIR", &self.0);
        command.env("CARGO_TERM_QUIET", "false").env("CARGO_TERM_COLOR", "never");
        command
    }

    /// The directories under `run`, one for each profiled build whose profile is still there.
    fn runs(&self) -> Vec<PathBuf> {
        let run = self.0.join("target").join("corten-profile").join("run");
        std::fs::read_dir(run).unwrap().map(|entry| entry.unwrap().path()).collect()
    }

    fn release(&self) -> PathBuf {
        self.0.join("target").join("release").join("profiled")
    }

    fn profile(&self) -> PathBuf {
        self.0.join("target").join("corten-profile").join("app.profdata")
    }

    /// Whether the program the last build started is still running.
    fn app_runs(&self) -> bool {
        let pid = std::fs::read_to_string(self.0.join("pid.txt")).unwrap();
        Command::new("sh").args(["-c", "kill -0 \"$1\"", "sh", pid.trim()]).output().unwrap().status.success()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `--profile-from` and a command that leaves the port it was given in `port.txt`.
const NOTES_ITS_PORT: [&str; 4] = ["--profile-from", "sh", "-c", "echo \"$PORT\" > port.txt"];

/// A port nothing listened on a moment ago.
fn unused_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap().local_addr().unwrap().port()
}

fn text(output: &Output) -> String {
    format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr))
}

/// Whether Cargo's dep-info file `built_from` names `path` (under the fixture's `root`, its
/// dep-info base) as one of a target's inputs: each input is read whole, relative to the base,
/// with Cargo's escaped spaces undone.
fn names_as_input(built_from: &str, root: &Path, path: &Path) -> bool {
    let wanted = path.strip_prefix(root).unwrap().to_str().unwrap();
    built_from.lines().filter_map(|line| line.split_once(": ")).any(|(_, inputs)| {
        let mut read = Vec::new();
        let mut input = String::new();
        let mut chars = inputs.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\\' if chars.peek() == Some(&' ') => input.push(chars.next().unwrap()),
                ' ' => read.push(std::mem::take(&mut input)),
                c => input.push(c),
            }
        }
        read.push(input);
        read.iter().any(|input| input == wanted)
    })
}

/// Whether `binary` was built to write a profile: the file name pattern it would write to is in it.
fn instrumented_binary(binary: &Path) -> bool {
    let bytes = std::fs::read(binary).unwrap();
    bytes.windows(b".profraw".len()).any(|window| window == b".profraw")
}

#[test]
fn the_release_is_built_with_the_profile_the_app_wrote_while_the_command_ran() {
    let fixture = Fixture::new("built");
    // A HOST the shell holds for the app's deploy (here one nothing can listen on) is not the
    // copy's: it listens on this machine, where the build and the command look for it.
    let output = fixture.build(&NOTES_ITS_PORT).env("HOST", "192.0.2.1").output().unwrap();
    let said = text(&output);
    assert!(output.status.success(), "{said}");
    assert!(said.contains("with a profile of the app under"), "{said}");
    // The command was given the port the app listened on, and the app was stopped after it.
    let port = std::fs::read_to_string(fixture.0.join("port.txt")).unwrap();
    assert!(port.trim().parse::<u16>().is_ok_and(|port| port != 0), "PORT was {port:?}");
    assert!(said.contains(&format!("the instrumented app on port {}", port.trim())), "{said}");
    assert!(!fixture.app_runs(), "the instrumented app was left running");
    // Only the app's profile was merged, not the one the instrumented build script wrote.
    assert!(said.contains("of the 1 profile file(s) the app wrote"), "{said}");

    // The compiler was given the merged profile: it names the file among what the binary is
    // built from, which is also what has Cargo build again when a later profile replaces it.
    assert!(fixture.profile().is_file(), "no merged profile");
    let built_from = std::fs::read_to_string(fixture.release().with_extension("d")).unwrap();
    assert!(
        names_as_input(&built_from, &fixture.0, &fixture.profile()),
        "the release was not built from the profile: {built_from}"
    );
    // The copy that writes a profile is the one under corten-profile, never the release.
    assert!(!instrumented_binary(&fixture.release()), "target/release writes a profile");
    let copy = fixture.0.join("target").join("corten-profile").join("target").join("release").join("profiled");
    assert!(instrumented_binary(&copy));

    // A second profiled build has nothing to compile in the copy, and compiles the release
    // again with the profile that replaced the first.
    let again = fixture.build(&NOTES_ITS_PORT).output().unwrap();
    let said = text(&again);
    assert!(again.status.success(), "{said}");
    let (copy, release) = said.split_once("the release build, with the profile").expect("the step's line");
    assert_eq!(copy.matches("Compiling profiled").count(), 0, "{said}");
    assert_eq!(release.matches("Compiling profiled").count(), 1, "{said}");
}

/// An app that binds a port of its own and never reads `PORT` (`corten::serve_on` with its own
/// listeners) is profiled when the build is given that port: the copy is looked for there, and
/// the command is sent there. Left to pick a port, the build would wait a minute on one the
/// app never opens.
#[test]
fn an_app_that_binds_a_port_of_its_own_is_profiled_when_port_names_it() {
    let fixture = Fixture::new("own-port");
    let port = unused_port().to_string();
    let output = fixture.build(&NOTES_ITS_PORT).env("PORT", &port).env("FIXTURE_LISTENS_ON", &port).output().unwrap();
    let said = text(&output);
    assert!(output.status.success(), "{said}");
    assert!(said.contains(&format!("the instrumented app on port {port}, while")), "{said}");
    assert_eq!(std::fs::read_to_string(fixture.0.join("port.txt")).unwrap().trim(), port, "the command's PORT");
    assert!(!fixture.app_runs(), "the instrumented app was left running");
    assert!(said.contains("of the 1 profile file(s) the app wrote"), "{said}");
    let built_from = std::fs::read_to_string(fixture.release().with_extension("d")).unwrap();
    assert!(
        names_as_input(&built_from, &fixture.0, &fixture.profile()),
        "the release was not built from the profile: {built_from}"
    );
    // An app that reads PORT is started on the same one, not on a port the build picked.
    let again = fixture.build(&NOTES_ITS_PORT).env("PORT", &port).output().unwrap();
    assert!(again.status.success(), "{}", text(&again));
    assert_eq!(std::fs::read_to_string(fixture.0.join("port.txt")).unwrap().trim(), port);
}

/// A `PORT` that is no port, or one something already listens on (which would answer the
/// command in the copy's place), is refused before anything is built.
#[test]
fn a_port_that_is_no_port_or_is_taken_is_refused_before_building() {
    let fixture = Fixture::new("port");
    for no_port in ["", "0", "http", "65536"] {
        let output = fixture.build(&NOTES_ITS_PORT).env("PORT", no_port).output().unwrap();
        assert!(!output.status.success(), "PORT={no_port:?}");
        assert!(text(&output).contains(&format!("PORT is {no_port:?}, not a port number")), "{}", text(&output));
    }
    let held = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = held.local_addr().unwrap().port();
    let output = fixture.build(&NOTES_ITS_PORT).env("PORT", port.to_string()).output().unwrap();
    assert!(!output.status.success());
    assert!(text(&output).contains(&format!("something already listens on port {port}")), "{}", text(&output));
    assert!(!fixture.0.join("target").exists(), "something was built before the refusal");
    drop(held);
}

/// The instrumented build takes minutes, so the port is looked at again before the copy starts:
/// what began to listen there meanwhile would accept the connection that waits for the copy.
#[test]
fn a_port_taken_while_the_copy_was_built_is_refused_before_the_copy_starts() {
    let fixture = Fixture::new("port-taken");
    // A build script that says the instrumented build has begun, which is after the check
    // before the first build, and holds it there until the test has taken the port.
    let waits = r#"fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    std::fs::write("building.txt", "").unwrap();
    while !std::path::Path::new("go.txt").exists() {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
"#;
    std::fs::write(fixture.0.join("build.rs"), waits).unwrap();
    let port = unused_port();
    let mut build = fixture.build(&NOTES_ITS_PORT);
    build.env("PORT", port.to_string()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut build = build.spawn().unwrap();
    while !fixture.0.join("building.txt").exists() {
        assert!(build.try_wait().unwrap().is_none(), "the build ended before it built the copy");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let held = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap();
    std::fs::write(fixture.0.join("go.txt"), "").unwrap();
    let output = build.wait_with_output().unwrap();
    let said = text(&output);
    assert!(!output.status.success(), "{said}");
    assert!(said.contains(&format!("something already listens on port {port}")), "{said}");
    assert!(said.contains("target/release is as it was"), "{said}");
    assert!(!fixture.0.join("pid.txt").exists() && !fixture.0.join("port.txt").exists(), "the copy or the command ran");
    assert!(!fixture.release().exists(), "a release was built");
    drop(held);
}

#[test]
fn a_command_or_an_app_that_fails_stops_the_build_and_leaves_the_release() {
    let fixture = Fixture::new("stopped");
    let plain = fixture.build(&[]).output().unwrap();
    assert!(plain.status.success(), "{}", text(&plain));
    let release = std::fs::read(fixture.release()).unwrap();

    let output = fixture.build(&["--profile-from", "sh", "-c", "exit 3"]).output().unwrap();
    assert!(!output.status.success());
    assert!(text(&output).contains("so no profile was taken; target/release is as it was"), "{}", text(&output));
    assert!(!fixture.app_runs(), "the instrumented app was left running after its command failed");

    // A command that is there and cannot be started: its interpreter is not.
    {
        use std::os::unix::fs::PermissionsExt;
        let script = fixture.0.join("train.sh");
        std::fs::write(&script, "#!/no/such/interpreter\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = fixture.build(&["--profile-from", "./train.sh"]).output().unwrap();
        assert!(!output.status.success());
        assert!(text(&output).contains("could not run ./train.sh"), "{}", text(&output));
        assert!(!fixture.app_runs(), "the instrumented app was left running after its command could not start");
    }

    // An app that exits while its command runs has a profile of part of the run. The command
    // waits (ten seconds at most) for the app to say it is leaving, and then half a second,
    // a margin for it to have left: the build cannot see a zombie from the command.
    let stops_the_app = "rm -f stopped.txt; kill -TERM \"$(cat pid.txt)\"; n=0; until [ -f stopped.txt ] || [ $n -ge 100 ]; do sleep 0.1; n=$((n+1)); done; sleep 0.5";
    let output = fixture.build(&["--profile-from", "sh", "-c", stops_the_app]).output().unwrap();
    assert!(!output.status.success());
    assert!(text(&output).contains("exited while the command ran"), "{}", text(&output));

    // An app that exits before it listens: its command is never run.
    let output = fixture.build(&NOTES_ITS_PORT).env("FIXTURE_EXITS_AT_ONCE", "1").output().unwrap();
    assert!(!output.status.success());
    assert!(text(&output).contains("exited before it listened"), "{}", text(&output));
    assert!(!fixture.0.join("port.txt").exists(), "the command ran without the app");

    assert!(!fixture.profile().exists(), "a profile was merged from nothing");
    assert_eq!(std::fs::read(fixture.release()).unwrap(), release, "a stopped build changed target/release");
}

#[test]
fn an_app_that_writes_no_profile_is_not_given_the_one_an_earlier_run_left() {
    let fixture = Fixture::new("stale");
    let first = fixture.build(&NOTES_ITS_PORT).output().unwrap();
    assert!(first.status.success(), "{}", text(&first));
    let merged = std::fs::read(fixture.profile()).unwrap();
    // The first run's profile is still there, in a directory of that run's own.
    let runs = fixture.runs();
    let [first_run] = &runs[..] else { panic!("one run: {runs:?}") };
    let profiles = std::fs::read_dir(first_run).unwrap().map(|entry| entry.unwrap().path());
    assert_eq!(profiles.filter(|file| file.extension().is_some_and(|ext| ext == "profraw")).count(), 1);

    let second = fixture.build(&NOTES_ITS_PORT).env("FIXTURE_QUITS_WITHOUT_A_PROFILE", "1").output().unwrap();
    assert!(!second.status.success(), "{}", text(&second));
    assert!(text(&second).contains("the app exited without writing a profile"), "{}", text(&second));
    // The earlier run's was removed, not left for a later build to find under the same id.
    assert!(!first_run.exists(), "the first run's profile was left");
    assert_eq!(std::fs::read(fixture.profile()).unwrap(), merged, "a profile was merged from the earlier run's file");
}

#[test]
fn flags_the_configuration_sets_refuse_the_build_and_flags_given_in_the_environment_reach_both_builds() {
    let fixture = Fixture::new("flags");
    // The program compiles only with the flag, so a build that dropped it fails.
    let needs_flag = format!("#[cfg(not(given))]\ncompile_error!(\"the flag was dropped\");\n{MAIN}");
    std::fs::write(fixture.0.join("src/main.rs"), needs_flag).unwrap();
    std::fs::create_dir_all(fixture.0.join(".cargo")).unwrap();
    let config = fixture.0.join(".cargo").join("config.toml");
    std::fs::write(&config, "[build]\nrustflags = [\"--cfg\", \"given\"]\n").unwrap();

    // With no flags in the environment, and none of its configuration variables either.
    let mut bare = fixture.build(&NOTES_ITS_PORT);
    bare.env_remove("RUSTFLAGS");
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(|name| name.starts_with("CARGO_") && name.ends_with("_RUSTFLAGS")) {
            bare.env_remove(name);
        }
    }
    let refused = bare.output().unwrap();
    assert!(!refused.status.success());
    let said = text(&refused);
    assert!(said.contains(&format!("{} sets rustflags", config.display())) && said.contains("RUSTFLAGS"), "{said}");
    assert!(!fixture.0.join("target").exists(), "something was built before the refusal");

    let output = fixture.build(&NOTES_ITS_PORT).env("RUSTFLAGS", "--cfg given").output().unwrap();
    assert!(output.status.success(), "{}", text(&output));
    assert!(!instrumented_binary(&fixture.release()));
}

#[test]
fn build_refuses_what_it_does_not_take_before_building() {
    let fixture = Fixture::new("refused");
    for (args, says) in [
        (&["--profile-form", "sh"][..], "corten build takes --features"),
        (&["--release"], "corten build takes --features"),
        (&["--target", "x86_64-unknown-linux-musl", "--profile-from", "true"], "not \"--target\""),
        (&["--bin", "--profile-from", "true"], "--bin needs a value"),
        (&["--profile-from"], "--profile-from needs a command"),
        (&["--profile-from", "/no/such/command"], "there is no command \"/no/such/command\""),
        (&["--profile-from", "--help"], "there is no command \"--help\""),
    ] {
        let output = fixture.build(args).output().unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(text(&output).contains(says), "{args:?}: {}", text(&output));
    }
    assert!(!fixture.0.join("target").exists(), "something was built");
}

#[test]
fn a_package_with_two_binaries_is_refused_and_neither_is_run() {
    let fixture = Fixture::new("two");
    std::fs::create_dir_all(fixture.0.join("src/bin")).unwrap();
    std::fs::write(fixture.0.join("src/bin/worker.rs"), "fn main() {}\n").unwrap();
    let output = fixture.build(&NOTES_ITS_PORT).output().unwrap();
    assert!(!output.status.success());
    let said = text(&output);
    assert!(said.contains("the build makes 2 binaries") && said.contains("worker"), "{said}");
    assert!(said.contains("name the one with --bin"), "{said}");
    assert!(!fixture.0.join("pid.txt").exists() && !fixture.0.join("port.txt").exists(), "one was run");
    assert!(!fixture.release().exists(), "a release was built");
}

/// The Cargo arguments given before `--profile-from` reach both builds, as written and in their
/// order. The app is a workspace member that is not the default one (the root package does not
/// compile), it compiles only with a feature its defaults leave off, `--bin` names it beside a
/// second binary, and a `cargo` first on the `PATH` records each argument each build was given.
#[test]
fn cargo_arguments_before_the_command_reach_both_builds() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("args");
    let root = "[package]\nname = \"profiled\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[workspace]\nmembers = [\"app\"]\n";
    std::fs::write(fixture.0.join("Cargo.toml"), root).unwrap();
    std::fs::write(fixture.0.join("src/main.rs"), "compile_error!(\"the default member was built\");\n").unwrap();
    let app = fixture.0.join("app");
    std::fs::create_dir_all(app.join("src/bin")).unwrap();
    let manifest = "[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[features]\ndefault = [\"plain\"]\nplain = []\ngiven = []\n";
    std::fs::write(app.join("Cargo.toml"), manifest).unwrap();
    let needs_feature = format!(
        "#[cfg(any(not(feature = \"given\"), feature = \"plain\"))]\ncompile_error!(\"the arguments were dropped\");\n{MAIN}"
    );
    std::fs::write(app.join("src/main.rs"), needs_feature).unwrap();
    std::fs::write(app.join("src/bin/worker.rs"), "fn main() {}\n").unwrap();

    // A lock, which `--locked` needs.
    let locked = Command::new(env!("CARGO")).arg("generate-lockfile").current_dir(&fixture.0).output().unwrap();
    assert!(locked.status.success(), "{}", text(&locked));
    // Each call as its argument count, then its arguments, each ended by a NUL, so boundaries
    // (an empty argument's, one with a newline's) are kept.
    let bin = fixture.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let cargo = bin.join("cargo");
    let script = "#!/bin/sh\nprintf '%s\\0' \"$#\" \"$@\" >> \"$ARGS_LOG\"\nexec \"$REAL_CARGO\" \"$@\"\n";
    std::fs::write(&cargo, script).unwrap();
    std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = fixture.0.join("cargo-args.txt");
    let mut path = std::ffi::OsString::from(&bin);
    path.push(":");
    path.push(std::env::var_os("PATH").unwrap());
    let builds = || -> Vec<Vec<String>> {
        let logged = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_file(&log);
        assert_eq!(logged.chars().last(), Some('\0'), "a call's record was cut: {logged:?}");
        let mut fields = logged.split_terminator('\0');
        let mut calls = Vec::new();
        while let Some(count) = fields.next() {
            let count: usize = count.parse().unwrap_or_else(|_| panic!("not a count: {count:?} in {logged:?}"));
            let call: Vec<String> = fields.by_ref().take(count).map(str::to_string).collect();
            assert_eq!(call.len(), count, "a call's record was cut: {logged:?}");
            calls.push(call);
        }
        calls.into_iter().filter(|call| call.first().is_some_and(|arg| arg == "build")).collect()
    };
    let given = ["--no-default-features", "--features=given", "-F", "", "-p", "app", "--locked", "--bin", "app"];
    let release: Vec<String> = ["build", "--release"].iter().chain(&given).map(|arg| arg.to_string()).collect();
    let run = |args: &[&str]| {
        let mut build = fixture.build(args);
        build.env("PATH", &path).env("ARGS_LOG", &log).env("REAL_CARGO", env!("CARGO"));
        build.output().unwrap()
    };

    let mut args = given.to_vec();
    args.extend(NOTES_ITS_PORT);
    let output = run(&args);
    let said = text(&output);
    assert!(output.status.success(), "{said}");
    let copy = fixture.0.join("target").join("corten-profile").join("target");
    let instrumented = [
        &release[..],
        &["--message-format=json-render-diagnostics".to_string(), "--target-dir".into(), copy.display().to_string()],
    ]
    .concat();
    assert_eq!(builds(), [instrumented, release.clone()]);
    assert!(said.contains("of the 1 profile file(s) the app wrote"), "{said}");
    let released = fixture.0.join("target").join("release").join("app");
    let built_from = std::fs::read_to_string(released.with_extension("d")).unwrap();
    assert!(
        names_as_input(&built_from, &fixture.0, &fixture.profile()),
        "the release was not built from the profile: {built_from}"
    );
    assert!(instrumented_binary(&copy.join("release").join("app")) && !instrumented_binary(&released));
    let worker = fixture.0.join("target").join("release").join("worker");
    assert!(!worker.exists(), "--bin did not reach the release build");

    // And the build without a profile.
    std::fs::remove_file(&released).unwrap();
    let plain = run(&given);
    assert!(plain.status.success(), "{}", text(&plain));
    assert!(released.is_file() && !worker.exists());
    assert_eq!(builds(), [release]);
}
#[test]
fn a_second_profiled_build_in_the_target_directory_is_refused_before_it_builds() {
    let fixture = Fixture::new("locked");
    let dir = fixture.0.join("target").join("corten-profile");
    std::fs::create_dir_all(&dir).unwrap();
    // What a profiled build that is running holds.
    let held = std::fs::File::create(dir.join("lock")).unwrap();
    held.lock().unwrap();
    let output = fixture.build(&NOTES_ITS_PORT).output().unwrap();
    assert!(!output.status.success());
    assert!(text(&output).contains("another corten build --profile-from is running"), "{}", text(&output));
    assert!(!dir.join("target").exists() && !fixture.0.join("pid.txt").exists(), "it built or ran the app");
    drop(held);
}

/// A toolchain without llvm-profdata is named, with the command that adds it, before any build.
#[test]
fn a_toolchain_without_llvm_profdata_is_refused_before_any_build() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("no-tool");
    // A `rustc` first on the PATH that names a sysroot with no tools in it.
    let bin = fixture.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let rustc = bin.join("rustc");
    let script = format!(
        "#!/bin/sh\ncase \"$*\" in\n  \"--print sysroot\") echo {} ;;\n  -vV) echo 'host: x86_64-unknown-linux-gnu' ;;\n  *) exit 1 ;;\nesac\n",
        fixture.0.join("sysroot").display()
    );
    std::fs::write(&rustc, script).unwrap();
    std::fs::set_permissions(&rustc, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());

    let mut build = fixture.build(&["--profile-from", "true"]);
    build.env("PATH", path).env_remove("RUSTC").env_remove("CARGO_BUILD_RUSTC");
    let output = build.output().unwrap();
    assert!(!output.status.success());
    let said = text(&output);
    assert!(said.contains("llvm-profdata") && said.contains("rustup component add llvm-tools"), "{said}");
    assert!(!fixture.0.join("target").exists(), "something was built before the refusal");
}
