//! The command must refuse a changed dependency graph without repairing its lock.

use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("corten-locked-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn write(&self, path: &str, text: &str) {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn cargo(&self, dir: &Path, args: &[&str]) -> Output {
        Command::new("cargo").args(args).current_dir(dir).env("CARGO_TARGET_DIR", self.0.join("target")).output().unwrap()
    }

    fn check(&self, dir: &Path) -> Output {
        Command::new(env!("CARGO_BIN_EXE_corten"))
            .args(["check", "--no-script-types"])
            .current_dir(dir)
            .env("CARGO_TARGET_DIR", self.0.join("target"))
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn success(output: Output) {
    assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

fn refuses_changed_lock(workspace: bool) {
    let fixture = Fixture::new(if workspace { "workspace" } else { "standalone" });
    let package = "[package]\nname = \"lock-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n";
    let manifest = if workspace { "app/Cargo.toml" } else { "Cargo.toml" };
    if workspace {
        fixture.write("Cargo.toml", "[workspace]\nmembers = [\"app\", \"helper\"]\nresolver = \"3\"\n");
        fixture.write(manifest, package);
        fixture.write("app/src/lib.rs", "pub fn value() {}\n");
    } else {
        fixture.write(manifest, &format!("{package}\n[workspace]\nexclude = [\"helper\"]\n"));
        fixture.write("src/lib.rs", "pub fn value() {}\n");
    }
    fixture.write("helper/Cargo.toml", "[package]\nname = \"lock-helper\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
    fixture.write("helper/src/lib.rs", "pub fn value() {}\n");
    let dir = if workspace { fixture.0.join("app") } else { fixture.0.clone() };
    let lock = fixture.0.join("Cargo.lock");
    // Missing locks are refused, not created, including a library's lock at a workspace root.
    let missing = fixture.check(&dir);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("--locked"));
    assert!(!lock.exists());
    success(fixture.cargo(&dir, &["generate-lockfile", "--offline"]));
    let before = std::fs::read(&lock).unwrap();
    success(fixture.check(&dir));
    assert_eq!(std::fs::read(&lock).unwrap(), before);
    if workspace {
        assert!(!dir.join("Cargo.lock").exists(), "the member uses its workspace's lock");
    }
    let path = fixture.0.join(manifest);
    let original = std::fs::read_to_string(&path).unwrap();
    let helper = if workspace { "../helper" } else { "helper" };
    std::fs::write(&path, format!("{original}\n[dependencies]\nlock-helper = {{ path = \"{helper}\" }}\n")).unwrap();
    let stale = fixture.check(&dir);
    assert!(!stale.status.success(), "a stale lock passed");
    let error = String::from_utf8_lossy(&stale.stderr);
    assert!(error.contains("--locked") && error.contains("cargo build") && error.contains("corten dev"), "{error}");
    assert!(error.contains("commit Cargo.lock"), "{error}");
    assert_eq!(std::fs::read(&lock).unwrap(), before, "the check must not repair the lock");
    success(fixture.cargo(&dir, &["build", "--offline"]));
    assert_ne!(std::fs::read(&lock).unwrap(), before);
    success(fixture.check(&dir));
}

#[test]
fn standalone_check_requires_a_fresh_lock() {
    refuses_changed_lock(false);
}

#[test]
fn member_check_uses_the_workspace_root_lock() {
    refuses_changed_lock(true);
}
