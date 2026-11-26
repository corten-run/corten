use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// The port `corten dev` hands the app: `--port`'s in either spelling over an inherited `PORT`,
/// and `PORT`'s without the flag.
#[test]
fn dev_gives_the_app_the_port_its_flag_names_over_port() {
    let base = std::env::temp_dir().join(format!("corten-dev-port-{}", std::process::id()));
    std::fs::create_dir_all(base.join("bin")).unwrap();
    let cargo = base.join("bin").join(format!("cargo{}", std::env::consts::EXE_SUFFIX));
    let status = Command::new("rustc")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/dev-cargo.rs"))
        .arg("-o")
        .arg(&cargo)
        .status()
        .unwrap();
    assert!(status.success());
    let cases: &[(&[&str], &str)] = &[(&["--port", "4000"], "4000"), (&["--port=4000"], "4000"), (&[], "4500")];
    let mut seen = Vec::new();
    for (at, (args, _)) in cases.iter().enumerate() {
        // An app of its own for each run, so no run copies over a binary another started.
        let root = base.join(format!("app-{at}"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        seen.push(port_given(&base, &root, args, &base.join(format!("port-{at}"))));
    }
    let _ = std::fs::remove_dir_all(&base);
    for ((args, expected), (port, said)) in cases.iter().zip(&seen) {
        assert_eq!(port.as_deref(), Some(*expected), "corten dev {args:?} with PORT=4500 said:\n{said}");
    }
}

/// Runs `corten dev` with `args` until the app it starts writes its `PORT` to `out`: that port,
/// and what `corten dev` wrote to stderr.
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
        if let Ok(port) = std::fs::read_to_string(out)
            && !port.is_empty()
        {
            break Some(port);
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
