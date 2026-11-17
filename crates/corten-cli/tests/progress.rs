use std::{
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

#[test]
fn redirected_check_reports_a_step_before_it_finishes_and_keeps_cargo_output() {
    let root = std::env::temp_dir().join(format!("corten-check-progress-{}", std::process::id()));
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let cargo = root.join("bin").join(format!("cargo{}", std::env::consts::EXE_SUFFIX));
    let status = Command::new("rustc")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/progress-cargo.rs"))
        .arg("-o")
        .arg(&cargo)
        .status()
        .unwrap();
    assert!(status.success());
    let release = root.join("release");
    let _ = std::fs::remove_file(&release);
    let mut child = Command::new(env!("CARGO_BIN_EXE_corten"))
        .args(["check", "--no-script-types"])
        .current_dir(&root)
        .env("PATH", root.join("bin"))
        .env("CHECK_RELEASE", &release)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (send, receive) = mpsc::channel();
    let stderr = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if send.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut lines = Vec::new();
    while let Ok(line) = receive.recv_timeout(Duration::from_secs(10)) {
        let compiling = line == "Compiling check-progress-fixture";
        lines.push(line);
        if compiling {
            break;
        }
    }
    // Observe the message while the child is still building, not from a buffered final output.
    let running = child.try_wait().unwrap().is_none();
    let started = lines.iter().any(|line| line.starts_with("corten check: cargo test"));
    std::fs::write(&release, "").unwrap();
    let status = child.wait().unwrap();
    reader.join().unwrap();
    lines.extend(receive);
    let mut stdout = String::new();
    child.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();
    // A failed test build still reports its time, fails the check, and checks scripts afterward.
    let failed = Command::new(env!("CARGO_BIN_EXE_corten"))
        .args(["check", "--no-script-types"])
        .current_dir(&root)
        .env("PATH", root.join("bin"))
        .env("CHECK_RELEASE", &release)
        .env("CHECK_FAIL_TESTS", "1")
        .output()
        .unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    let failed_stderr = String::from_utf8(failed.stderr).unwrap();
    assert!(!failed.status.success(), "{failed_stderr}");
    let failed_at = failed_stderr
        .lines()
        .position(|line| line.starts_with("corten check: cargo test") && line.contains(" failed after "))
        .unwrap();
    let scripts_at = failed_stderr.lines().position(|line| line == "corten check: script types").unwrap();
    assert!(failed_at < scripts_at, "{failed_stderr}");
    assert!(status.success(), "{lines:?}");
    assert!(running && started, "no step reported while Cargo was still running: {lines:?}");
    assert!(lines.iter().any(|line| line == "Compiling check-progress-fixture"), "{lines:?}");
    assert!(lines.iter().any(|line| line.starts_with("corten check: cargo test") && line.contains(" finished in ")), "{lines:?}");
    assert_eq!(stdout, "test-output\n");
}

#[test]
fn a_closed_stderr_does_not_change_what_check_does() {
    let root = std::env::temp_dir().join(format!("corten-check-closed-stderr-{}", std::process::id()));
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let cargo = root.join("bin").join(format!("cargo{}", std::env::consts::EXE_SUFFIX));
    let status = Command::new("rustc")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/progress-cargo.rs"))
        .arg("-o")
        .arg(&cargo)
        .status()
        .unwrap();
    assert!(status.success());
    let release = root.join("release");
    let _ = std::fs::remove_file(&release);
    let mut child = Command::new(env!("CARGO_BIN_EXE_corten"))
        .args(["check", "--no-script-types"])
        .current_dir(&root)
        .env("PATH", root.join("bin"))
        .env("CHECK_RELEASE", &release)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // The reader goes away while the test step is held, so at least that step's closing line is
    // written to a closed pipe.
    drop(child.stderr.take());
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(&release, "").unwrap();
    let mut stdout = String::new();
    child.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();
    let status = child.wait().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
    assert!(status.success(), "check failed with a closed stderr: {status}");
    assert_eq!(stdout, "test-output\n");
}
