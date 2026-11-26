use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
    // Every app has exited and been reaped, so nothing holds the directory.
    std::fs::remove_dir_all(&base).unwrap();
    for ((args, expected), (port, said)) in cases.iter().zip(&seen) {
        assert_eq!(port.as_deref(), Some(*expected), "corten dev {args:?} with PORT=4500 said:\n{said}");
    }
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
            let _ = dev.kill();
            let _ = dev.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let cargo_ran = ran.exists();
    let stderr = std::fs::read_to_string(&said).unwrap();
    std::fs::remove_dir_all(&base).unwrap();
    assert!(status.is_some_and(|status| !status.success()), "{status:?}: {stderr}");
    assert!(stderr.contains(r#"corten dev takes --port <port> (or --port=<port>); not "--prot""#), "{stderr}");
    assert!(!cargo_ran, "Cargo ran for a refused argument");
}

/// A directory holding `bin/cargo`, the stand-in for Cargo and the app (`fixtures/dev-cargo.rs`).
fn stand_in(name: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("corten-dev-{name}-{}", std::process::id()));
    // Left by an interrupted run of a process with the same id, its port files and marks would
    // pass for this run's.
    if base.exists() {
        std::fs::remove_dir_all(&base).unwrap();
    }
    std::fs::create_dir_all(base.join("bin")).unwrap();
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
/// `corten dev` has said the app exited: that port, and what `corten dev` wrote to stderr.
fn port_given(base: &Path, root: &Path, args: &[&str], out: &Path) -> (Option<String>, String) {
    let said = out.with_extension("stderr");
    let mut dev = Command::new(env!("CARGO_BIN_EXE_corten"))
        .arg("dev")
        .args(args)
        .current_dir(root)
        .env("PATH", base.join("bin"))
        .env("PORT", "4500")
        .env("DEV_PORT_OUT", out)
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
    let _ = dev.kill();
    let _ = dev.wait();
    (port, std::fs::read_to_string(&said).unwrap_or_default())
}
