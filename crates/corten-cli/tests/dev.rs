use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// The port `corten dev` hands the app: `--port`'s in either spelling over an inherited `PORT`,
/// and `PORT`'s without the flag.
#[test]
fn dev_gives_the_app_the_port_its_flag_names_over_port() {
    let base = stand_in("port");
    let cases: &[(&[&str], &str)] = &[(&["--port", "4000"], "4000"), (&["--port=4000"], "4000"), (&[], "4500")];
    let mut seen = Vec::new();
    for (at, (args, _)) in cases.iter().enumerate() {
        // An app of its own for each run, so no run copies over a binary another started.
        seen.push(port_given(&base, &app(&base, at), args, &base.join(format!("port-{at}"))));
    }
    // A port is read only once `corten dev` has said its app exited, so with every port read and
    // every `corten dev` seen to exit nothing is left running in the directory and it is removed.
    // Otherwise a child may still be at work there, and the directory is kept and named. A failed
    // removal is reported after the assertions, so it does not hide what the runs found.
    let done = seen.iter().all(|(port, _, stopped)| port.is_some() && stopped.is_ok());
    let removed = done.then(|| std::fs::remove_dir_all(&base));
    for ((args, expected), (port, said, stopped)) in cases.iter().zip(&seen) {
        let kept = base.display();
        assert_eq!(port.as_deref(), Some(*expected), "corten dev {args:?} with PORT=4500 said:\n{said}\n(kept {kept})");
        assert!(stopped.is_ok(), "corten dev {args:?}: {stopped:?} (kept {kept})");
    }
    removed.expect("every run read its port and stopped").expect("removing the test's directory");
}

/// An argument `corten dev` does not take is refused before Cargo runs, so a misspelled flag
/// does not start the app on another port.
#[test]
fn dev_refuses_an_argument_it_does_not_take_before_it_builds() {
    let base = stand_in("refused");
    let ran = base.join("cargo-ran");
    let said = base.join("stderr");
    let mut dev = Command::new(env!("CARGO_BIN_EXE_corten"))
        .args(["dev", "--prot", "4000"])
        .current_dir(app(&base, 0))
        .env("PATH", base.join("bin"))
        .env("DEV_CARGO_RAN", &ran)
        .env_remove("DEV_PORT_OUT")
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&said).unwrap())
        .spawn()
        .unwrap();
    // Bounded: a `corten dev` that took the argument would run until stopped.
    let start = Instant::now();
    let status = loop {
        if let Some(status) = dev.try_wait().unwrap() {
            break Some(status);
        }
        if start.elapsed() > Duration::from_secs(30) {
            // A run that took the argument: stopped, or said not to have stopped.
            let stopped = stop(&mut dev);
            assert!(stopped.is_ok(), "corten dev --prot 4000 ran on: {stopped:?} (kept {})", base.display());
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let cargo_ran = ran.exists();
    let stderr = std::fs::read_to_string(&said).unwrap();
    // With `corten dev` exited and Cargo never run, nothing else was started in the directory.
    // Otherwise the stand-in or the app may still be at work there, so the directory is kept.
    let removed = (status.is_some() && !cargo_ran).then(|| std::fs::remove_dir_all(&base));
    assert!(status.is_some_and(|status| !status.success()), "{status:?}: {stderr}\n(kept {})", base.display());
    assert!(stderr.contains(r#"corten dev takes --port <port> (or --port=<port>); not "--prot""#), "{stderr}");
    assert!(!cargo_ran, "Cargo ran for a refused argument (kept {})", base.display());
    removed.expect("corten dev exited without running Cargo").expect("removing the test's directory");
}

/// A directory holding `bin/cargo`, the stand-in for Cargo and the app (`fixtures/dev-cargo.rs`).
/// Every process the stand-in runs as exits as soon as it has written, so stopping `corten dev`
/// leaves nothing running in the directory.
fn stand_in(name: &str) -> PathBuf {
    // Made new for this run, never reused: one left by another run (a process with the same id,
    // in another PID namespace sharing the temp directory) is skipped, not removed, so its port
    // files and marks cannot pass for this run's.
    let base = (0..)
        .map(|attempt| {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
            // Absolute, so the paths given to `corten dev`, which runs in another directory, name
            // the same files whatever `TMPDIR` says.
            std::path::absolute(std::env::temp_dir())
                .unwrap()
                .join(format!("corten-dev-{name}-{}-{nanos}-{attempt}", std::process::id()))
        })
        .find(|base| match std::fs::create_dir(base) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => panic!("creating {}: {error}", base.display()),
        })
        .unwrap();
    std::fs::create_dir(base.join("bin")).unwrap();
    let cargo = base.join("bin").join(format!("cargo{}", std::env::consts::EXE_SUFFIX));
    let status = Command::new("rustc")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/dev-cargo.rs"))
        .arg("-o")
        .arg(&cargo)
        .status()
        .unwrap();
    assert!(status.success());
    base
}

/// An app directory under `base`: a `Cargo.toml` is all `corten dev` looks for.
fn app(base: &Path, at: usize) -> PathBuf {
    let root = base.join(format!("app-{at}"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("Cargo.toml"), "").unwrap();
    root
}

/// Runs `corten dev` with `args` until the app it starts has written its `PORT` to `out` and
/// `corten dev` has said the app exited: that port, what `corten dev` wrote to stderr, and whether
/// `corten dev` was seen to exit once stopped ([`stop`]).
fn port_given(base: &Path, root: &Path, args: &[&str], out: &Path) -> (Option<String>, String, Result<(), String>) {
    let said = out.with_extension("stderr");
    let mut dev = Command::new(env!("CARGO_BIN_EXE_corten"))
        .arg("dev")
        .args(args)
        .current_dir(root)
        .env("PATH", base.join("bin"))
        .env("PORT", "4500")
        .env("DEV_PORT_OUT", out)
        // Only the refusal test asks the stand-in to mark that it ran, inside its own directory.
        .env_remove("DEV_CARGO_RAN")
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&said).unwrap())
        .spawn()
        .unwrap();
    let start = Instant::now();
    let port = loop {
        let port = std::fs::read_to_string(out).ok().filter(|port| !port.is_empty());
        let reaped = std::fs::read_to_string(&said).is_ok_and(|said| said.contains("corten: the app exited"));
        if port.is_some() && reaped {
            break port;
        }
        if start.elapsed() > Duration::from_secs(30) || dev.try_wait().unwrap().is_some() {
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stopped = stop(&mut dev);
    (port, std::fs::read_to_string(&said).unwrap_or_default(), stopped)
}

/// Stops `child` and waits at most 5 seconds to see it exit: an error when it was not seen to,
/// rather than a wait with no end.
fn stop(child: &mut Child) -> Result<(), String> {
    // A child that has exited already refuses the kill; whether it exited is what is looked at.
    let killed = child.kill();
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if start.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => return Err(format!("not seen to exit 5 s after it was stopped (kill: {killed:?})")),
            Err(error) => return Err(format!("its exit could not be read: {error} (kill: {killed:?})")),
        }
    }
}
