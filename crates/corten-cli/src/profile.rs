//! `corten build --profile-from <command>`: the release binary, built with a profile of the app
//! at work (docs/guide/deploy.md, "A profile-guided build").
//!
//! Four steps, each the toolchain's own: an instrumented build, that copy of the app run while
//! `<command>` sends it requests, `llvm-profdata merge`, and the release build given the merged
//! profile. The instrumented build has a target directory of its own under
//! `target/corten-profile`, so `target/release` never holds a binary that writes a profile, and
//! a step that fails leaves the last release as it was. What can be told is wrong without
//! building (no `llvm-profdata`, flags the profile's would replace, a system that cannot ask the
//! app to stop, a command that is not there, another profiled build in the same target
//! directory) is refused before the first step. What only the build tells (a package with two
//! binaries) is refused after the instrumented build.

use std::{
    ffi::{OsStr, OsString},
    io::Write,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

use crate::dev;

/// What separates the flags in `CARGO_ENCODED_RUSTFLAGS`.
const BETWEEN_FLAGS: &str = "\u{1f}";
/// How long the instrumented app has to listen, and then to exit once asked to.
const STARTS_WITHIN: Duration = Duration::from_secs(60);
const STOPS_WITHIN: Duration = Duration::from_secs(60);

/// Builds with `cargo`, the Cargo arguments `corten build` passes on (main.rs, `CARGO_ARGS`),
/// given to both builds in the same order, so the profile is of the binary the release is.
pub fn run(command: &[String], cargo: &[String]) -> Result<(), String> {
    // The app writes its profile as it exits, so it has to be asked to stop, not killed, and
    // the standard library can only kill. On Unix the shell's `kill` asks; Windows has no
    // command that sends another process a Ctrl-C.
    if !cfg!(unix) {
        return Err(
            "--profile-from stops the app with SIGTERM so that it writes its profile, which this system cannot send. Build in a Linux container, as the Dockerfile does"
                .into(),
        );
    }
    let root = std::env::current_dir().map_err(|e| e.to_string())?;
    if !root.join("Cargo.toml").is_file() {
        return Err("run corten build in the app's directory (where Cargo.toml is)".into());
    }
    there(&command[0], std::env::var_os("PATH"))?;
    let profdata = profdata(&root)?;
    let flags = base_flags(std::env::var_os("CARGO_ENCODED_RUSTFLAGS"), std::env::var_os("RUSTFLAGS"), || {
        Ok(set_elsewhere(&root, std::env::vars_os().map(|(name, _)| name), cargo_home()?))
    })?;
    let dir = target_directory(&root)?.join("corten-profile");
    // Held until this returns: one profiled build at a time in a target directory.
    let _only = only_build_in(&dir)?;
    let (written_by_build, runs, merged) = (dir.join("build"), dir.join("run"), dir.join("app.profdata"));
    // This run's own: a copy that an earlier build left running (a build ended by a signal
    // cannot stop it) writes into that build's directory when it exits, not into this one.
    let taken = runs.join(std::process::id().to_string());

    step("the instrumented build, in target/corten-profile");
    let built = dev::binaries_of(
        Command::new("cargo")
            .args(["build", "--release"])
            .args(cargo)
            .args(["--message-format=json-render-diagnostics", "--target-dir"])
            .arg(dir.join("target"))
            .env("CARGO_ENCODED_RUSTFLAGS", with(&flags, "-Cprofile-generate=", &written_by_build))
            .current_dir(&root),
    )
    .map_err(|error| format!("the instrumented build: {error}; target/release is as it was"))?;
    let app = the_one_binary(built)?;
    // The macros and build scripts of that build were instrumented too and wrote here as they
    // ran. The app's own profile goes to a directory of its own, and what earlier runs left is
    // removed: where the process id repeats (a build in a container), a file left in this
    // run's directory would be merged as this run's.
    emptied(&written_by_build)?;
    emptied(&runs)?;

    let shown = command.join(" ");
    let port = free_port()?;
    step(&format!("the instrumented app on port {port}, while {shown} runs"));
    let mut running = Running::start(&app, port, &root, &taken)?;
    running.listens(port).map_err(unchanged)?;
    let status = Command::new(&command[0])
        .args(&command[1..])
        .env("PORT", port.to_string())
        .current_dir(&root)
        .status()
        .map_err(|e| format!("could not run {}: {e}; target/release is as it was", command[0]));
    // Whatever the command did, the app is stopped before its result is read.
    let stopped = running.stop();
    let status = status?;
    if !status.success() {
        // A command often fails because the copy did, so both are said.
        let copy = stopped.err().map(|error| format!(", and {error}")).unwrap_or_default();
        return Err(format!("{shown} failed ({status}){copy}, so no profile was taken; target/release is as it was"));
    }
    stopped.map_err(unchanged)?;
    let files = profiles(&taken);
    if files == 0 {
        return Err(
            "the app exited without writing a profile; target/release is as it was. It writes one when it returns from main, as a Corten app does on SIGTERM"
                .into(),
        );
    }

    step(&format!("llvm-profdata merge, of the {files} profile file(s) the app wrote"));
    let status = Command::new(&profdata)
        .arg("merge")
        .arg("-o")
        .arg(&merged)
        .arg(&taken)
        .status()
        .map_err(|e| format!("could not run {}: {e}", profdata.display()))?;
    if !status.success() {
        return Err(format!("llvm-profdata merge failed ({status}); target/release is as it was"));
    }

    step("the release build, with the profile");
    let status = Command::new("cargo")
        .args(["build", "--release"])
        .args(cargo)
        .env("CARGO_ENCODED_RUSTFLAGS", with(&flags, "-Cprofile-use=", &merged))
        .current_dir(&root)
        .status()
        .map_err(|e| format!("could not run cargo: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build --release {}failed", cargo.iter().map(|arg| format!("{arg} ")).collect::<String>()));
    }
    println!(
        "\ncorten: built the release binary in target/release with a profile of the app under {shown}. The static files are compiled into it. An image built from the Dockerfile builds its own binary, without this profile."
    );
    Ok(())
}

/// The build takes minutes and four steps; say which one the output below belongs to.
fn step(name: &str) {
    let _ = writeln!(std::io::stderr(), "corten build: {name}");
}

/// Refuses a command that is not there before the first build, not after it. A name with a
/// `/` is a path; any other is looked for on `path` (the environment's `PATH`), as it is when
/// it is run. A file that is there and cannot be run is found when it is started.
fn there(command: &str, path: Option<OsString>) -> Result<(), String> {
    let found = if command.contains('/') {
        Path::new(command).is_file()
    } else {
        // Without a PATH the system searches a default one, which this does not know.
        path.is_none_or(|path| std::env::split_paths(&path).any(|dir| dir.join(command).is_file()))
    };
    if found { Ok(()) } else { Err(format!("--profile-from: there is no command {command:?} to run")) }
}

/// What a failure before the release build adds to its message.
fn unchanged(error: String) -> String {
    format!("{error}; target/release is as it was")
}

/// The one profiled build in a target directory, for as long as the file it gives is held. Two
/// at once (two apps of a workspace) share `run` and the merged profile, so one would merge
/// the other's profile files or build its release with the other's profile, without a word.
fn only_build_in(dir: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join("lock");
    let lock = std::fs::File::create(&path).map_err(|e| format!("could not create {}: {e}", path.display()))?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(std::fs::TryLockError::WouldBlock) => Err(format!(
            "another corten build --profile-from is running in {}, and the two would take each other's profile; run them one at a time",
            dir.display()
        )),
        // A file system without locks, where Cargo builds without one too.
        Err(std::fs::TryLockError::Error(error)) if error.kind() == std::io::ErrorKind::Unsupported => Ok(lock),
        Err(std::fs::TryLockError::Error(error)) => Err(format!("could not lock {}: {error}", path.display())),
    }
}

/// The binary the build made, when it made one: a profile is of one program, and a release of
/// several would have the others built with a profile that is not theirs.
fn the_one_binary(mut built: Vec<PathBuf>) -> Result<PathBuf, String> {
    match built.len() {
        0 => Err("the package has no binary to run".into()),
        1 => Ok(built.remove(0)),
        _ => {
            let names: Vec<String> =
                built.iter().filter_map(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned()).collect();
            Err(format!(
                "the build makes {} binaries ({}), and a profile is of one; name the one with --bin (and its package with -p) before --profile-from",
                built.len(),
                names.join(", ")
            ))
        }
    }
}

/// Removes `dir` and what is in it. A directory that is not there is what was asked for; one
/// that cannot be removed would leave an earlier run's files to be taken for this one's.
fn emptied(dir: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not empty {}: {error}", dir.display())),
    }
}

/// A port nothing listens on, for the instrumented app: the app's usual one may be taken by a
/// `corten dev` in another terminal, which would then answer the command in the app's place.
/// A Corten app listens on both loopback addresses, so the port is free on both.
fn free_port() -> Result<u16, String> {
    for _ in 0..16 {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .map_err(|e| format!("could not find a free port: {e}"))?;
        match TcpListener::bind((Ipv6Addr::LOCALHOST, port)) {
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {}
            // Free there too, or a system without IPv6, where nothing else has it either.
            _ => return Ok(port),
        }
    }
    Err("could not find a port free on both 127.0.0.1 and [::1]".into())
}

/// The instrumented app while it runs. Dropped before it was stopped (a step failed), it is
/// killed. A `corten build` that is itself ended by a signal (a cancelled CI job, `timeout`)
/// cannot do that, as `corten dev` cannot: the standard library catches no signal, and the
/// copy then stays running. Ctrl-C in a terminal reaches the copy as well.
struct Running(Child);

impl Running {
    /// Starts `app` on `port` in the app's directory, writing its profile into `taken`.
    fn start(app: &Path, port: u16, root: &Path, taken: &Path) -> Result<Self, String> {
        Command::new(app)
            .env("PORT", port.to_string())
            // On this machine only, where `listens` and the command look for it: a HOST set
            // for the app's deploy would have the copy listen elsewhere, or on every interface.
            .env_remove("HOST")
            .env("LLVM_PROFILE_FILE", taken.join("%m-%p.profraw"))
            .current_dir(root)
            .spawn()
            .map(Self)
            .map_err(|e| format!("could not start {}: {e}", app.display()))
    }

    /// Waits until the app accepts a connection on `port`.
    fn listens(&mut self, port: u16) -> Result<(), String> {
        let addresses = [SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))];
        let start = Instant::now();
        loop {
            if let Some(status) = self.0.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("the instrumented app exited before it listened ({status})"));
            }
            if addresses.iter().any(|address| TcpStream::connect_timeout(address, Duration::from_millis(200)).is_ok()) {
                return Ok(());
            }
            if start.elapsed() > STARTS_WITHIN {
                return Err(format!(
                    "the instrumented app did not listen on port {port}, the PORT it was started with, within {} seconds",
                    STARTS_WITHIN.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Asks the app to stop and waits for it, so it writes its profile.
    fn stop(mut self) -> Result<(), String> {
        if let Some(status) = self.0.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "the instrumented app exited while the command ran ({status}), so its profile is not of the whole run"
            ));
        }
        // The shell's own `kill`: a system without the program (a slim image) still has that.
        let asked = Command::new("sh")
            .args(["-c", "kill -TERM \"$1\"", "sh", &self.0.id().to_string()])
            .status()
            .map_err(|e| format!("could not run sh to stop the app: {e}"))?;
        if !asked.success() {
            return Err(format!("kill -TERM could not stop the instrumented app ({asked})"));
        }
        let start = Instant::now();
        while start.elapsed() < STOPS_WITHIN {
            if self.0.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(format!(
            "the instrumented app was still running {} seconds after SIGTERM and was killed, and a killed app writes no profile",
            STOPS_WITHIN.as_secs()
        ))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The toolchain's `llvm-profdata`, which reads the profile format its rustc writes. One found
/// on the `PATH` may be another LLVM's, so only the toolchain's is used. The toolchain is that
/// of the compiler Cargo builds with: the one the environment names, or `rustc`. (One that
/// `build.rustc` names in a configuration file is not read.)
fn profdata(root: &Path) -> Result<PathBuf, String> {
    let compiler = std::env::var_os("RUSTC")
        .or_else(|| std::env::var_os("CARGO_BUILD_RUSTC"))
        .filter(|compiler| !compiler.is_empty())
        .unwrap_or_else(|| "rustc".into());
    let rustc = |args: &[&str]| -> Result<String, String> {
        let out =
            Command::new(&compiler).args(args).current_dir(root).output().map_err(|e| format!("could not run rustc: {e}"))?;
        if !out.status.success() {
            return Err(format!("rustc {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let sysroot = rustc(&["--print", "sysroot"])?;
    let version = rustc(&["-vV"])?;
    let host = version.lines().find_map(|line| line.strip_prefix("host: ")).ok_or("rustc -vV names no host")?;
    let tool = Path::new(sysroot.trim())
        .join("lib")
        .join("rustlib")
        .join(host.trim())
        .join("bin")
        .join(format!("llvm-profdata{}", std::env::consts::EXE_SUFFIX));
    if tool.is_file() {
        Ok(tool)
    } else {
        Err(format!(
            "--profile-from merges the app's profile with the toolchain's llvm-profdata, and {} is not there. Add it with: rustup component add llvm-tools",
            tool.display()
        ))
    }
}

/// Cargo's target directory for the app, which a workspace or `CARGO_TARGET_DIR` puts elsewhere
/// than the app's own `target`.
fn target_directory(root: &Path) -> Result<PathBuf, String> {
    let out = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("could not run cargo: {e}"))?;
    if !out.status.success() {
        return Err(format!("cargo metadata failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    crate::json::parse(&String::from_utf8_lossy(&out.stdout))
        .map_err(|error| format!("cargo metadata: {error}"))?
        .get("target_directory")
        .and_then(crate::json::Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "cargo metadata names no target directory".into())
}

/// The flags both builds start from, as `CARGO_ENCODED_RUSTFLAGS` holds them: the ones the
/// environment gives (`encoded` before `plain`, as Cargo reads them), or none.
///
/// Cargo takes its flags from one place only: the environment, or else the configuration
/// (`build.rustflags`, `target.<..>.rustflags`). The profile's flag has to go in the
/// environment, so it would replace flags the configuration sets, and both builds would lose a
/// linker or a CPU the app's ordinary build has, without a word. So when the environment gives
/// none and `elsewhere` finds some, the build is refused, naming the place.
fn base_flags(
    encoded: Option<OsString>,
    plain: Option<OsString>,
    elsewhere: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<OsString, String> {
    if let Some(encoded) = encoded {
        return Ok(encoded);
    }
    if let Some(plain) = plain {
        let plain = plain.to_str().ok_or("RUSTFLAGS is not UTF-8")?;
        // As Cargo splits it: on spaces, each piece trimmed, the empty ones dropped.
        let flags: Vec<&str> = plain.split(' ').map(str::trim).filter(|flag| !flag.is_empty()).collect();
        return Ok(flags.join(BETWEEN_FLAGS).into());
    }
    match elsewhere()? {
        Some(place) => Err(format!(
            "{place} sets rustflags or includes other configuration, and the flag a profile build puts in the environment would replace the flags set there. Give this command the flags the build needs in RUSTFLAGS and both builds keep them (an empty RUSTFLAGS builds with none)"
        )),
        None => Ok(OsString::new()),
    }
}

/// `flags` and then `flag` with `path` as its value.
fn with(flags: &OsStr, flag: &str, path: &Path) -> OsString {
    let mut all = flags.to_os_string();
    if !all.is_empty() {
        all.push(BETWEEN_FLAGS);
    }
    all.push(flag);
    all.push(path);
    all
}

/// The first place that may set rustflags which `RUSTFLAGS` in the environment would replace:
/// one of the environment's own configuration variables (`vars` are its names), or a
/// configuration file Cargo reads for a build in `root` (each directory above it, then Cargo's
/// home).
fn set_elsewhere(root: &Path, vars: impl Iterator<Item = OsString>, cargo_home: PathBuf) -> Option<String> {
    for name in vars {
        if let Some(name) = name.to_str()
            && (name == "CARGO_BUILD_RUSTFLAGS" || (name.starts_with("CARGO_TARGET_") && name.ends_with("_RUSTFLAGS")))
        {
            return Some(name.to_string());
        }
    }
    root.ancestors()
        .map(|dir| dir.join(".cargo"))
        .chain([cargo_home])
        .flat_map(|dir| [dir.join("config.toml"), dir.join("config")])
        .find(|file| std::fs::read_to_string(file).is_ok_and(|text| may_set_rustflags(&text)))
        .map(|file| file.display().to_string())
}

/// Whether a line of a Cargo configuration file, other than a comment, names `rustflags` or
/// `include`, the key that brings in other files, which may set them (`include = [..]`, or a
/// `[[include]]` table). The command has no TOML parser and does not need one to refuse: it
/// refuses a file that may set flags, one that sets them for another target included, and an
/// empty `RUSTFLAGS` says that none are wanted.
fn may_set_rustflags(config: &str) -> bool {
    config
        .lines()
        .map(str::trim_start)
        .any(|line| !line.starts_with('#') && (line.contains("rustflags") || line.contains("include")))
}

/// Cargo's home, where its last configuration file is: `CARGO_HOME`, or `.cargo` in the user's
/// home, which is `USERPROFILE` on Windows and `HOME` elsewhere. Without either, Cargo asks the
/// system for the user's directory, which this cannot, so it refuses: a file there may set
/// flags.
fn cargo_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("CARGO_HOME").filter(|home| !home.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    let user = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(user).filter(|home| !home.is_empty()).map(|home| PathBuf::from(home).join(".cargo")).ok_or_else(|| {
        format!(
            "neither CARGO_HOME nor {user} is set, so the configuration in Cargo's home cannot be read for rustflags the profile's flag would replace. Give this command the flags the build needs in RUSTFLAGS (an empty RUSTFLAGS builds with none)"
        )
    })
}

/// How many profile files the app wrote to `dir`.
fn profiles(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.filter_map(Result::ok).filter(|entry| entry.path().extension().is_some_and(|ext| ext == "profraw")).count()
}

#[cfg(test)]
mod tests {
    use super::{base_flags, may_set_rustflags, set_elsewhere, the_one_binary, with};
    #[cfg(unix)]
    use super::{emptied, there};
    use std::{
        ffi::OsString,
        path::{Path, PathBuf},
    };

    #[test]
    fn the_builds_keep_the_environments_flags_and_add_theirs_last() {
        let none = || Ok(None);
        // Cargo reads the encoded form before the plain one, and so does this.
        let both = base_flags(Some("-Ca\u{1f}--cfg=b c".into()), Some("-Cplain".into()), none).unwrap();
        assert_eq!(both, "-Ca\u{1f}--cfg=b c");
        let plain = base_flags(None, Some(" -Ctarget-cpu=native  --cfg\t x\n".into()), none).unwrap();
        assert_eq!(plain, "-Ctarget-cpu=native\u{1f}--cfg\u{1f}x");
        // A path with a space in it stays one flag, which the plain form could not say.
        assert_eq!(
            with(&plain, "-Cprofile-use=", Path::new("/my app/target/app.profdata")),
            "-Ctarget-cpu=native\u{1f}--cfg\u{1f}x\u{1f}-Cprofile-use=/my app/target/app.profdata"
        );
        assert_eq!(with(&OsString::new(), "-Cprofile-generate=", Path::new("/t/build")), "-Cprofile-generate=/t/build");
    }

    #[test]
    fn flags_the_configuration_sets_refuse_the_build_unless_the_environment_gives_some() {
        let config = || Ok(Some("/app/.cargo/config.toml".to_string()));
        let refused = base_flags(None, None, config).unwrap_err();
        assert!(refused.starts_with("/app/.cargo/config.toml sets rustflags"), "{refused}");
        assert!(refused.contains("RUSTFLAGS"), "{refused}");
        // An empty RUSTFLAGS is given: Cargo then reads no configuration flags either.
        assert_eq!(base_flags(None, Some(OsString::new()), config), Ok(OsString::new()));
        assert_eq!(base_flags(Some("-Ca".into()), None, config), Ok("-Ca".into()));
        assert_eq!(base_flags(None, None, || Ok(None)), Ok(OsString::new()));
        // What could not be looked for is not taken for nothing found.
        assert_eq!(base_flags(None, None, || Err("no home".into())), Err("no home".into()));
        assert_eq!(base_flags(None, Some(OsString::new()), || Err("no home".into())), Ok(OsString::new()));
    }

    #[test]
    fn a_configuration_line_that_may_set_rustflags_is_found_and_a_comment_is_not() {
        assert!(may_set_rustflags("[build]\nrustflags = [\"-Ctarget-cpu=native\"]\n"));
        assert!(may_set_rustflags("[target.x86_64-unknown-linux-gnu]\n  rustflags = [\"-Clink-arg=-fuse-ld=lld\"]\n"));
        assert!(may_set_rustflags("build.rustflags = \"-Ca\"\n"));
        // Another file's flags are this build's too.
        assert!(may_set_rustflags("include = [\"shared.toml\"]\n[build]\njobs = 2\n"));
        assert!(may_set_rustflags("[build]\njobs = 2\n\n[[include]]\npath = \"flags.toml\"\n"));
        assert!(!may_set_rustflags("[build]\n# rustflags = [\"-Ctarget-cpu=native\"]\njobs = 2\n# include = \"x.toml\"\n"));
        assert!(!may_set_rustflags("[registry]\nglobal-min-publish-age = \"3 days\"\n"));
        // `[env]` gives rustc's children a variable; Cargo does not read its own flags from it.
        assert!(!may_set_rustflags("[env]\nRUSTFLAGS = \"-Ca\"\n"));
    }

    #[test]
    fn rustflags_are_looked_for_where_cargo_reads_them() {
        let base = std::env::temp_dir().join(format!("corten-profile-flags-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (app, home) = (base.join("work").join("app"), base.join("home"));
        std::fs::create_dir_all(app.join(".cargo")).unwrap();
        std::fs::create_dir_all(base.join("work").join(".cargo")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let vars = |names: &[&str]| names.iter().map(OsString::from).collect::<Vec<_>>().into_iter();
        let found = |names: &[&str]| set_elsewhere(&app, vars(names), home.clone());
        // A directory above the fixture is the machine's, and may set flags of its own.
        let ours = |place: &Option<String>| place.as_ref().is_some_and(|place| Path::new(place).starts_with(&base));

        std::fs::write(app.join(".cargo").join("config.toml"), "[build]\njobs = 2\n").unwrap();
        assert!(!ours(&found(&["PATH", "CARGO_TARGET_DIR", "CARGO_BUILD_JOBS"])));
        // The environment's configuration variables, which RUSTFLAGS replaces as it does a file's.
        assert_eq!(found(&["CARGO_BUILD_RUSTFLAGS"]).as_deref(), Some("CARGO_BUILD_RUSTFLAGS"));
        let target = "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS";
        assert_eq!(found(&["PATH", target]).as_deref(), Some(target));
        // A directory above the app, the old file name, and Cargo's home.
        let above = base.join("work").join(".cargo").join("config");
        std::fs::write(&above, "[build]\nrustflags = [\"-Ca\"]\n").unwrap();
        assert_eq!(found(&[]), Some(above.display().to_string()));
        std::fs::remove_file(&above).unwrap();
        let in_home = home.join("config.toml");
        std::fs::write(&in_home, "[target.'cfg(unix)']\nrustflags = [\"-Ca\"]\n").unwrap();
        let result = found(&[]);
        let _ = std::fs::remove_dir_all(&base);
        // Unless a directory above the temporary one sets flags, the last place read is the home.
        let read_home = result.as_ref().is_some_and(|place| *place == in_home.display().to_string() || !ours(&result));
        assert!(read_home, "{result:?}");
    }

    #[test]
    #[cfg(unix)]
    fn a_command_that_is_not_there_is_refused() {
        let base = std::env::temp_dir().join(format!("corten-profile-there-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (bin, other) = (base.join("bin"), base.join("other"));
        std::fs::create_dir_all(bin.join("a-directory")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(bin.join("train"), "").unwrap();
        let path = || Some(std::env::join_paths([&other, &bin]).unwrap());
        let results = [
            // A name is looked for in each directory of the PATH, and a directory is not a command.
            there("train", path()),
            there("trian", path()),
            there("a-directory", path()),
            // A name with a slash is a path, whatever the PATH holds.
            there(bin.join("train").to_str().unwrap(), Some(OsString::new())),
            there(bin.join("trian").to_str().unwrap(), path()),
            // Without a PATH the system has its own, so nothing is refused.
            there("trian", None),
        ];
        let _ = std::fs::remove_dir_all(&base);
        let refused = Err("--profile-from: there is no command \"trian\" to run".to_string());
        assert_eq!(results[0], Ok(()));
        assert_eq!(results[1], refused);
        assert!(results[2].is_err());
        assert_eq!(results[3], Ok(()));
        assert!(results[4].is_err());
        assert_eq!(results[5], Ok(()));
    }

    #[test]
    fn a_profile_is_of_one_binary() {
        assert_eq!(the_one_binary(vec![PathBuf::from("/t/release/shop")]), Ok(PathBuf::from("/t/release/shop")));
        assert_eq!(the_one_binary(Vec::new()), Err("the package has no binary to run".into()));
        let two = the_one_binary(vec![PathBuf::from("/t/release/shop"), PathBuf::from("/t/release/worker")]).unwrap_err();
        assert!(two.contains("2 binaries (shop, worker)"), "{two}");
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_is_emptied_or_the_build_stops() {
        let base = std::env::temp_dir().join(format!("corten-profile-emptied-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // One that is not there is already empty.
        assert_eq!(emptied(&base.join("run")), Ok(()));
        std::fs::create_dir_all(base.join("run")).unwrap();
        std::fs::write(base.join("run").join("old.profraw"), "").unwrap();
        assert_eq!(emptied(&base.join("run")), Ok(()));
        assert!(!base.join("run").exists());
        // Any failure but "not there" stops the build: here, a path through a file.
        std::fs::write(base.join("file"), "").unwrap();
        let refused = emptied(&base.join("file").join("run"));
        let _ = std::fs::remove_dir_all(&base);
        assert!(refused.is_err_and(|error| error.starts_with("could not empty ")));
    }
}
