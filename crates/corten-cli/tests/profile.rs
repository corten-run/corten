//! `corten build --profile-from <command>`, run for real on a small program that listens and
//! stops as an app does. The toolchain's llvm-profdata must be installed
//! (`rustup component add llvm-tools`). Unix only, as the option is: it stops the app with
//! SIGTERM.
#![cfg(unix)]

use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

/// A program that listens on `PORT` (at `HOST`, when that is set), works while it waits, and
/// returns from `main` on SIGTERM, as a Corten app does. It writes its process id to `pid.txt`
/// and, as it leaves, `stopped.txt`. Two variables change it:
/// `FIXTURE_EXITS_AT_ONCE` (it never listens) and `FIXTURE_QUITS_WITHOUT_A_PROFILE` (on SIGTERM
/// it leaves without running what writes a profile, as a killed app does).
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
    let port = std::env::var("PORT").expect("PORT");
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
    /// none from a configuration file either. Cargo says what it compiles, in plain text, which
    /// a test reads.
    fn build(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_corten"));
        command.arg("build").args(args).current_dir(&self.0).env("CARGO_TARGET_DIR", self.0.join("target"));
        command.env_remove("CARGO_ENCODED_RUSTFLAGS").env("RUSTFLAGS", "");
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

fn text(output: &Output) -> String {
    format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr))
}

/// Whether `binary` was built to write a profile: the file name pattern it would write to is in it.
fn instrumented(binary: &Path) -> bool {
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
    assert!(built_from.contains("app.profdata"), "the release was not built from the profile: {built_from}");
    // The copy that writes a profile is the one under corten-profile, never the release.
    assert!(!instrumented(&fixture.release()), "target/release writes a profile");
    let copy = fixture.0.join("target").join("corten-profile").join("target").join("release").join("profiled");
    assert!(instrumented(&copy));

    // A second profiled build has nothing to compile in the copy, and compiles the release
    // again with the profile that replaced the first.
    let again = fixture.build(&NOTES_ITS_PORT).output().unwrap();
    let said = text(&again);
    assert!(again.status.success(), "{said}");
    let (copy, release) = said.split_once("the release build, with the profile").expect("the step's line");
    assert_eq!(copy.matches("Compiling profiled").count(), 0, "{said}");
    assert_eq!(release.matches("Compiling profiled").count(), 1, "{said}");
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
    assert!(!instrumented(&fixture.release()));
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
/// order: the program compiles only with a feature its defaults leave off, `--bin` names it beside
/// a second binary, and a `cargo` first on the `PATH` records what each build was given.
#[test]
fn cargo_arguments_before_the_command_reach_both_builds() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("args");
    let manifest = "[package]\nname = \"profiled\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[features]\ndefault = [\"plain\"]\nplain = []\ngiven = []\n\n[workspace]\n";
    std::fs::write(fixture.0.join("Cargo.toml"), manifest).unwrap();
    let needs_feature = format!(
        "#[cfg(any(not(feature = \"given\"), feature = \"plain\"))]\ncompile_error!(\"the arguments were dropped\");\n{MAIN}"
    );
    std::fs::write(fixture.0.join("src/main.rs"), needs_feature).unwrap();
    std::fs::create_dir_all(fixture.0.join("src/bin")).unwrap();
    std::fs::write(fixture.0.join("src/bin/worker.rs"), "fn main() {}\n").unwrap();

    // A lock, which `--locked` needs.
    let locked = Command::new(env!("CARGO")).arg("generate-lockfile").current_dir(&fixture.0).output().unwrap();
    assert!(locked.status.success(), "{}", text(&locked));
    let bin = fixture.0.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let cargo = bin.join("cargo");
    let log = fixture.0.join("cargo-args.txt");
    let script = format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexec '{}' \"$@\"\n", log.display(), env!("CARGO"));
    std::fs::write(&cargo, script).unwrap();
    std::fs::set_permissions(&cargo, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let given = "--no-default-features --features=given -p profiled --locked --bin profiled";
    let builds = || -> Vec<String> {
        let logged = std::fs::read_to_string(&log).unwrap_or_default();
        let builds = logged.lines().filter(|line| line.starts_with("build ")).map(str::to_string).collect();
        let _ = std::fs::remove_file(&log);
        builds
    };

    let mut args: Vec<&str> = given.split(' ').collect();
    args.extend(NOTES_ITS_PORT);
    let output = fixture.build(&args).env("PATH", &path).output().unwrap();
    let said = text(&output);
    assert!(output.status.success(), "{said}");
    let profiled = builds();
    assert_eq!(profiled.len(), 2, "{profiled:?}");
    for build in &profiled {
        assert!(
            build.starts_with(&format!("build --release {given} ")) || *build == format!("build --release {given}"),
            "{build}"
        );
    }
    assert!(said.contains("of the 1 profile file(s) the app wrote"), "{said}");
    let built_from = std::fs::read_to_string(fixture.release().with_extension("d")).unwrap();
    assert!(built_from.contains("app.profdata"), "the release was not built from the profile: {built_from}");
    let worker = fixture.0.join("target").join("release").join("worker");
    assert!(!worker.exists(), "--bin did not reach the release build");

    // And the build without a profile.
    std::fs::remove_file(fixture.release()).unwrap();
    let plain = fixture.build(&args[..7]).env("PATH", &path).output().unwrap();
    assert!(plain.status.success(), "{}", text(&plain));
    assert!(fixture.release().is_file() && !worker.exists());
    assert_eq!(builds(), [format!("build --release {given}")]);
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
