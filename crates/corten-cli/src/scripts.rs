//! `corten check`'s type check of the app's scripts: TypeScript's `tsc`, in JavaScript mode, over
//! every `.js` file in `src/` and `static/`, against the DOM's types, the `corten` runtime's
//! JSDoc and declarations (`js/views.d.ts`: `rows()`, `view()`, `Holds`; `js/events.d.ts`) and the
//! app's generated `types/app.d.ts` (feed rows, its `corten/events` and `corten/views` classes).
//!
//! A handler's call is checked when the crate compiles; this checks its body. TypeScript is not
//! a dependency of an app: the check uses `tsc` from the app's `node_modules` or the `PATH`,
//! and fails when there is none and the app has scripts, so a machine or a CI job without
//! TypeScript cannot pass with the scripts unchecked. `corten check --no-script-types` skips them
//! and says so, for a machine that cannot run it.
//!
//! At a workspace root it checks each member that depends on `corten`, with that member's own
//! `types/`, as `cargo test` there tests each of them.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use crate::json::{self, Value};

/// Directories that hold no app scripts.
const IGNORED: &[&str] = &["target", "node_modules", ".git"];

/// A workspace member that depends on `corten`, in or under the directory `corten check` runs in.
#[derive(Debug, PartialEq)]
struct App {
    /// Cargo's package id, which a dependency of the same name from elsewhere does not share.
    id: String,
    name: String,
    root: PathBuf,
}

/// What `corten check` type-checks from `dir`, settled before its long steps run: the app in
/// `dir`, or at a workspace root each member that depends on `corten`, as `cargo test` covers each
/// of them, and the `tsc` that checks their scripts. `None` when none of them has a script. With
/// `skip` (`--no-script-types`) it does not look for `tsc`; without it, an app with scripts and no
/// `tsc` fails here, before format, lint and tests have taken their time.
pub fn plan(dir: &Path, skip: bool) -> Result<Option<Plan>, String> {
    let metadata = json::parse(&cargo_metadata(dir)?).map_err(|e| format!("cargo metadata: {e}"))?;
    plan_with(&metadata, dir, skip, find_tsc)
}

/// The scripts `corten check` type-checks and how ([`plan`]).
#[derive(Debug)]
pub struct Plan {
    apps: Vec<App>,
    whose: String,
    /// `None` when skipped, else the `tsc` and the corten runtime's `js/` and the target directory.
    run: Option<(PathBuf, PathBuf, PathBuf)>,
}

/// [`plan`] from cargo's metadata, with `find` looking for `tsc` in the given homes.
fn plan_with(
    metadata: &Value,
    dir: &Path,
    skip: bool,
    find: impl FnOnce(&[&Path]) -> Option<PathBuf>,
) -> Result<Option<Plan>, String> {
    let mut count = 0;
    let apps: Vec<App> = apps(metadata, dir)
        .into_iter()
        .filter(|app| {
            let mut scripts = Vec::new();
            for sub in ["src", "static"] {
                collect(&app.root.join(sub), &mut scripts);
            }
            count += scripts.len();
            !scripts.is_empty()
        })
        .collect();
    if apps.is_empty() {
        return Ok(None);
    }
    let whose = if apps.len() == 1 {
        format!("the app's {count} script(s)")
    } else {
        let names: Vec<&str> = apps.iter().map(|app| app.name.as_str()).collect();
        format!("the {count} script(s) of {}", names.join(", "))
    };
    let mut homes: Vec<&Path> = apps.iter().map(|app| app.root.as_path()).collect();
    homes.push(dir);
    let run = match checker(skip, || find(&homes), &whose)? {
        None => None,
        Some(tsc) => {
            let runtime = corten_js_dir(metadata).ok_or("could not find the corten crate's js/ directory in cargo metadata")?;
            let target =
                metadata.get("target_directory").and_then(Value::as_str).ok_or("cargo metadata has no target_directory")?;
            Some((tsc, runtime, PathBuf::from(target)))
        }
    };
    Ok(Some(Plan { apps, whose, run }))
}

/// Type-checks the scripts `plan` found, or says how many it did not check when told to skip them.
pub fn run(plan: Option<Plan>) -> Result<(), String> {
    let Some(Plan { apps, whose, run }) = plan else { return Ok(()) };
    let Some((tsc, runtime, target)) = run else {
        eprintln!("corten: {whose} were not type-checked (--no-script-types)");
        return Ok(());
    };
    let mut failed = Vec::new();
    for app in &apps {
        let dir = target.join("corten").join(&app.name);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let config = dir.join("jsconfig.json");
        std::fs::write(&config, jsconfig(&app.root, &runtime)).map_err(|e| format!("write {}: {e}", config.display()))?;
        if apps.len() > 1 {
            eprintln!("corten: type-checking {}'s scripts", app.name);
        }
        let status = Command::new(&tsc)
            .arg("-p")
            .arg(&config)
            .current_dir(&app.root)
            .status()
            .map_err(|e| format!("could not run {}: {e}", tsc.display()))?;
        if !status.success() {
            failed.push(app.name.as_str());
        }
    }
    match failed[..] {
        [] => Ok(()),
        _ if apps.len() == 1 => Err("the app's scripts do not type-check (tsc, above)".into()),
        _ => Err(format!("the scripts of {} do not type-check (tsc, above)", failed.join(", "))),
    }
}

/// Every workspace member that depends on corten, with the packages it depends on, and the
/// directories of those `corten check` covers from `dir` (as `check` finds them).
pub(crate) fn app_roots(dir: &Path) -> Result<(Vec<crate::listed::Member>, Vec<PathBuf>), String> {
    let metadata = json::parse(&cargo_metadata(dir)?).map_err(|e| format!("cargo metadata: {e}"))?;
    Ok(members(&metadata, dir))
}

/// `app_roots` from cargo's metadata.
fn members(metadata: &Value, dir: &Path) -> (Vec<crate::listed::Member>, Vec<PathBuf>) {
    let root = metadata.get("workspace_root").and_then(Value::as_str).map_or_else(|| dir.to_path_buf(), PathBuf::from);
    let packages = metadata.get("packages").map_or(&[][..], Value::items);
    let package = |id: &str| packages.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id));
    let uses = |id: &str| -> Vec<String> {
        package(id)
            .and_then(|p| p.get("dependencies"))
            .map_or(&[][..], Value::items)
            .iter()
            // A member is always a path dependency; a registry crate of the same name is not it.
            .filter(|d| d.get("path").is_some())
            .filter_map(|d| d.get("name").and_then(Value::as_str).map(str::to_string))
            .collect()
    };
    // The root file of each library and binary target: where the compiler starts reading the
    // crate's modules. Tests, benches, examples and build scripts are not the app.
    let targets = |id: &str| -> Vec<PathBuf> {
        package(id)
            .and_then(|p| p.get("targets"))
            .map_or(&[][..], Value::items)
            .iter()
            .filter(|t| {
                t.get("kind")
                    .map_or(&[][..], Value::items)
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|k| matches!(k, "lib" | "rlib" | "dylib" | "cdylib" | "staticlib" | "proc-macro" | "bin"))
            })
            .filter_map(|t| t.get("src_path").and_then(Value::as_str).map(PathBuf::from))
            .collect()
    };
    let all = apps(metadata, &root)
        .into_iter()
        .map(|app| crate::listed::Member { uses: uses(&app.id), targets: targets(&app.id), name: app.name, root: app.root })
        .collect();
    (all, apps(metadata, dir).into_iter().map(|app| app.root).collect())
}

/// The workspace members whose directory is `dir` or under it and that depend on corten (under
/// either package name, [`crate::pin::PACKAGES`]), in cargo's order.
fn apps(metadata: &Value, dir: &Path) -> Vec<App> {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let dir = canonical(dir);
    let members: Vec<&str> =
        metadata.get("workspace_members").map_or(&[][..], Value::items).iter().filter_map(Value::as_str).collect();
    let packages = metadata.get("packages").map_or(&[][..], Value::items);
    packages
        .iter()
        .filter(|p| p.get("id").and_then(Value::as_str).is_some_and(|id| members.contains(&id)))
        .filter(|p| {
            p.get("dependencies")
                .map_or(&[][..], Value::items)
                .iter()
                .any(|d| d.get("name").and_then(Value::as_str).is_some_and(crate::pin::is_framework))
        })
        .filter_map(|p| {
            let id = p.get("id")?.as_str()?.to_string();
            let name = p.get("name")?.as_str()?.to_string();
            let root = Path::new(p.get("manifest_path")?.as_str()?).parent()?;
            canonical(root).starts_with(&dir).then(|| App { id, name, root: root.to_path_buf() })
        })
        .collect()
}

/// Every `.js` file under `dir`.
fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !IGNORED.contains(&name.to_string_lossy().as_ref()) {
                collect(&path, files);
            }
        } else if path.extension().is_some_and(|e| e == "js") {
            files.push(path);
        }
    }
}

/// The `tsc` that checks `whose` scripts (`find`'s), `None` when `skip` says not to look, or why
/// `corten check` fails without one, with the two ways on. A `tsc` whose `--version` fails, a
/// broken install, is not one.
fn checker(skip: bool, find: impl FnOnce() -> Option<PathBuf>, whose: &str) -> Result<Option<PathBuf>, String> {
    if skip {
        return Ok(None);
    }
    find().map(Some).ok_or_else(|| {
        format!(
            "{whose} could not be type-checked: no TypeScript tsc that runs (`tsc --version`) is \
             in node_modules/.bin or on the PATH. Install it (npm install --global typescript, or \
             in the app's package.json), or run corten check --no-script-types to check \
             everything else"
        )
    })
}

/// `tsc` from the `node_modules` of the first of `homes` that has one, else from the `PATH`
/// (`tsc.cmd` on Windows).
fn find_tsc(homes: &[&Path]) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["tsc.cmd", "tsc.exe", "tsc"] } else { &["tsc"] };
    let local = homes.iter().flat_map(|home| names.iter().map(move |n| home.join("node_modules").join(".bin").join(n)));
    let candidates = local.chain(names.iter().map(PathBuf::from));
    candidates.into_iter().find(|tsc| Command::new(tsc).arg("--version").output().is_ok_and(|o| o.status.success()))
}

fn cargo_metadata(root: &Path) -> Result<String, String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version", "1"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("could not run cargo metadata: {e}"))?;
    if !output.status.success() {
        return Err("cargo metadata failed".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The `js/` directory of the corten crate the app builds against: the package whose manifest
/// is in a directory named `corten` (a checkout) or `corten-run-{version}` (crates.io;
/// `corten-{version}` from before the rename) and has `js/corten.js`.
fn corten_js_dir(metadata: &Value) -> Option<PathBuf> {
    metadata.get("packages")?.items().iter().find_map(|package| {
        let dir = Path::new(package.get("manifest_path")?.as_str()?).parent()?;
        let name = dir.file_name()?.to_str()?;
        let release = |prefix: &str| name.strip_prefix(prefix).is_some_and(|v| v.starts_with(|c: char| c.is_ascii_digit()));
        let named = name == "corten" || release("corten-run-") || release("corten-");
        let js = dir.join("js");
        (named && js.join("corten.js").is_file()).then_some(js)
    })
}

/// The config `tsc` runs with: the same settings Corten checks its own scripts with.
fn jsconfig(root: &Path, runtime: &Path) -> String {
    let path = |p: PathBuf| json_string(&p.to_string_lossy().replace('\\', "/"));
    let include = [
        path(root.join("src").join("**").join("*.js")),
        path(root.join("static").join("**").join("*.js")),
        path(root.join("types").join("*.d.ts")),
        path(runtime.join("events.d.ts")),
        path(runtime.join("views.d.ts")),
    ]
    .join(", ");
    format!(
        r#"{{
  "//": "Written by corten check, which type-checks the app's scripts with it. Do not edit.",
  "compilerOptions": {{
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["es2022", "dom", "dom.iterable"],
    "types": [],
    "paths": {{ "corten": [{runtime}], "corten/keys": [{keys}] }}
  }},
  "include": [{include}]
}}
"#,
        runtime = path(runtime.join("corten.js")),
        keys = path(runtime.join("keys.js"))
    )
}

/// `text` as a JSON string.
fn json_string(text: &str) -> String {
    let mut out = String::from('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_without_tsc_fail_the_check_unless_it_is_told_to_skip_them() {
        let missing = checker(false, || None, "the app's 2 script(s)").unwrap_err();
        assert!(missing.starts_with("the app's 2 script(s) could not be type-checked"), "{missing}");
        assert!(missing.contains("npm install --global typescript") && missing.contains("--no-script-types"), "{missing}");
        assert_eq!(checker(false, || Some(PathBuf::from("tsc")), "x"), Ok(Some(PathBuf::from("tsc"))));
        // Told to skip, it does not look for one.
        assert_eq!(checker(true, || unreachable!("not looked for"), "x"), Ok(None));
    }

    /// `corten check`'s plan, the wiring: an app with a script fails without `tsc` before anything
    /// else runs, is skipped (and `tsc` not looked for) when told, and goes on to the runtime
    /// lookup when `tsc` is found; a workspace whose apps have no script never looks for `tsc`.
    #[test]
    fn the_check_plan_needs_tsc_only_for_an_app_with_scripts() {
        let base = std::env::temp_dir().join(format!("corten-check-plan-{}", std::process::id()));
        for dir in ["ws/app/src", "ws/bare/src"] {
            std::fs::create_dir_all(base.join(dir)).unwrap();
        }
        std::fs::write(base.join("ws/app/src/counter.js"), "export function count() {}\n").unwrap();
        let package = |name: &str| {
            let manifest = json_string(&base.join("ws").join(name).join("Cargo.toml").to_string_lossy());
            format!(
                r#"{{"name":"{name}","id":"{name}-id","manifest_path":{manifest},"dependencies":[{{"name":"corten-run","kind":null}}]}}"#
            )
        };
        let metadata = format!(
            r#"{{"packages":[{},{}],"workspace_members":["app-id","bare-id"],"target_directory":"/t"}}"#,
            package("app"),
            package("bare"),
        );
        let metadata = json::parse(&metadata).unwrap();
        let ws = base.join("ws");

        let missing = plan_with(&metadata, &ws, false, |_| None).unwrap_err();
        assert!(missing.starts_with("the app's 1 script(s) could not be type-checked"), "{missing}");

        let homes = std::cell::RefCell::new(Vec::new());
        let found = plan_with(&metadata, &ws, false, |at| {
            homes.borrow_mut().extend(at.iter().map(|home| home.to_path_buf()));
            Some(PathBuf::from("tsc"))
        });
        // Found, it goes on to find the corten runtime, which this metadata does not have.
        assert_eq!(found.unwrap_err(), "could not find the corten crate's js/ directory in cargo metadata");
        assert_eq!(*homes.borrow(), [base.join("ws/app"), ws.clone()], "the app's own node_modules first");

        let skipped = plan_with(&metadata, &ws, true, |_| unreachable!("not looked for")).unwrap();
        let skipped = skipped.expect("the app has a script");
        assert!(skipped.run.is_none());
        assert_eq!(skipped.whose, "the app's 1 script(s)");
        assert_eq!(run(Some(skipped)), Ok(()));

        let bare = plan_with(&metadata, &base.join("ws/bare"), false, |_| unreachable!("no script, no tsc")).unwrap();
        assert!(bare.is_none());
        assert_eq!(run(None), Ok(()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn finds_the_corten_crate_from_a_checkout_or_crates_io() {
        let base = std::env::temp_dir().join(format!("corten-check-scripts-{}", std::process::id()));
        for dir in [
            "registry/corten-0.1.0/js",
            "registry/corten-run-0.2.0/js",
            "registry/corten-macros-0.1.0/js",
            "checkout/crates/corten/js",
        ] {
            std::fs::create_dir_all(base.join(dir)).unwrap();
            std::fs::write(base.join(dir).join("corten.js"), "").unwrap();
        }
        let manifest = |dir: &str| json_string(&base.join(dir).join("Cargo.toml").to_string_lossy());
        let metadata = |dirs: &[&str]| {
            let packages: Vec<String> =
                dirs.iter().map(|d| format!(r#"{{"name":"x","manifest_path":{}}}"#, manifest(d))).collect();
            format!(r#"{{"packages":[{}],"target_directory":"/t"}}"#, packages.join(","))
        };
        let find = |dirs: &[&str]| corten_js_dir(&json::parse(&metadata(dirs)).unwrap());
        let found = find(&["registry/corten-macros-0.1.0", "registry/corten-0.1.0"]).unwrap();
        assert!(found.ends_with("corten-0.1.0/js"), "{found:?}");
        // A release since the rename unpacks as corten-run-{version}.
        let found = find(&["registry/corten-macros-0.1.0", "registry/corten-run-0.2.0"]).unwrap();
        assert!(found.ends_with("corten-run-0.2.0/js"), "{found:?}");
        let found = find(&["checkout/crates/corten"]).unwrap();
        assert!(found.ends_with("crates/corten/js"), "{found:?}");
        assert_eq!(find(&["registry/corten-macros-0.1.0"]), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_workspace_root_checks_each_member_that_uses_corten() {
        let base = std::env::temp_dir().join(format!("corten-check-members-{}", std::process::id()));
        for dir in ["ws/admin", "ws/market", "ws/tools", "registry/corten-0.1.0"] {
            std::fs::create_dir_all(base.join(dir)).unwrap();
        }
        let package = |name: &str, dir: &str, deps: &str| {
            let manifest = json_string(&base.join(dir).join("Cargo.toml").to_string_lossy());
            let deps: Vec<String> = deps.split_whitespace().map(|d| format!(r#"{{"name":"{d}","kind":null}}"#)).collect();
            format!(r#"{{"name":"{name}","id":"{name}-id","manifest_path":{manifest},"dependencies":[{}]}}"#, deps.join(","))
        };
        let metadata = format!(
            r#"{{"packages":[{},{},{},{}],"workspace_members":["admin-id","market-id","tools-id"],"target_directory":"/t"}}"#,
            package("admin", "ws/admin", "corten serde"),
            // An app on a release since the rename names the package corten-run.
            package("market", "ws/market", "corten-run"),
            package("tools", "ws/tools", "serde"),
            package("corten", "registry/corten-0.1.0", "corten-macros"),
        );
        let metadata = json::parse(&metadata).unwrap();
        let names = |dir: &str| apps(&metadata, &base.join(dir)).into_iter().map(|app| app.name).collect::<Vec<_>>();
        assert_eq!(names("ws"), ["admin", "market"]);
        assert_eq!(names("ws/market"), ["market"]);
        assert!(names("ws/tools").is_empty());
        let admin = apps(&metadata, &base.join("ws/admin")).remove(0);
        assert_eq!(admin.root, base.join("ws/admin"), "the root is the manifest's directory, as cargo wrote it");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The list check's members: each member that uses corten, with the members it depends on by
    /// path (not a registry crate of a member's name) and its library and binary roots (not its
    /// tests, examples or build script), and the ones covered from the directory it runs in.
    #[test]
    fn the_list_check_reads_each_members_targets_and_member_dependencies() {
        let base = std::env::temp_dir().join(format!("corten-check-targets-{}", std::process::id()));
        for dir in ["ws/kit", "ws/app", "ws/tools"] {
            std::fs::create_dir_all(base.join(dir)).unwrap();
        }
        let at = |dir: &str, file: &str| base.join(dir).join(file);
        let package = |name: &str, dir: &str, deps: &[(&str, bool)], targets: &[(&str, &str)]| {
            let manifest = json_string(&at(dir, "Cargo.toml").to_string_lossy());
            let deps: Vec<String> = deps
                .iter()
                .map(|(d, path)| {
                    let path = if *path {
                        format!(r#","path":{}"#, json_string(&base.join("ws").join(d).to_string_lossy()))
                    } else {
                        String::new()
                    };
                    format!(r#"{{"name":"{d}","kind":null{path}}}"#)
                })
                .collect();
            let targets: Vec<String> = targets
                .iter()
                .map(|(kind, file)| {
                    format!(r#"{{"kind":["{kind}"],"src_path":{}}}"#, json_string(&at(dir, file).to_string_lossy()))
                })
                .collect();
            format!(
                r#"{{"name":"{name}","id":"{name}-id","manifest_path":{manifest},"dependencies":[{}],"targets":[{}]}}"#,
                deps.join(","),
                targets.join(",")
            )
        };
        let metadata = format!(
            r#"{{"workspace_root":{},"packages":[{},{},{}],"workspace_members":["kit-id","app-id","tools-id"]}}"#,
            json_string(&base.join("ws").to_string_lossy()),
            package("kit", "ws/kit", &[("corten", false)], &[("lib", "lib.rs")]),
            package(
                "app",
                "ws/app",
                &[("corten", false), ("kit", true), ("serde", false)],
                &[
                    ("bin", "src/main.rs"),
                    ("bin", "bin/admin.rs"),
                    ("test", "tests/it.rs"),
                    ("example", "examples/e.rs"),
                    ("custom-build", "build.rs")
                ],
            ),
            package("tools", "ws/tools", &[("corten", false), ("kit", false)], &[("lib", "src/lib.rs")]),
        );
        let metadata = json::parse(&metadata).unwrap();
        let (all, checked) = members(&metadata, &base.join("ws/app"));
        let _ = std::fs::remove_dir_all(&base);
        let summary: Vec<(&str, Vec<PathBuf>, Vec<&str>)> =
            all.iter().map(|m| (m.name.as_str(), m.targets.clone(), m.uses.iter().map(String::as_str).collect())).collect();
        assert_eq!(
            summary,
            [
                ("kit", vec![at("ws/kit", "lib.rs")], vec![]),
                ("app", vec![at("ws/app", "src/main.rs"), at("ws/app", "bin/admin.rs")], vec!["kit"]),
                ("tools", vec![at("ws/tools", "src/lib.rs")], vec![]),
            ],
            "a registry crate named kit is not the member"
        );
        assert_eq!(checked, [base.join("ws/app")]);
    }

    #[test]
    fn the_config_maps_corten_and_includes_the_app_and_its_types() {
        let config = jsconfig(Path::new("/apps/shop"), Path::new("/reg/corten-0.1.0/js"));
        assert!(
            config.contains(
                r#""paths": { "corten": ["/reg/corten-0.1.0/js/corten.js"], "corten/keys": ["/reg/corten-0.1.0/js/keys.js"] }"#
            ),
            "{config}"
        );
        for part in
            ["/apps/shop/src/**/*.js", "/apps/shop/static/**/*.js", "/apps/shop/types/*.d.ts", "/reg/corten-0.1.0/js/views.d.ts"]
        {
            assert!(config.contains(&format!("\"{part}\"")), "{part} in {config}");
        }
    }

    #[test]
    fn an_app_s_scripts_are_checked_with_the_settings_corten_checks_its_own_with() {
        // Every compiler option but the paths, which point at each side's own files.
        let options = |text: &str| match json::parse(text).unwrap().get("compilerOptions") {
            Some(Value::Object(fields)) => fields.iter().filter(|(name, _)| name != "paths").cloned().collect::<Vec<_>>(),
            other => panic!("compilerOptions: {other:?}"),
        };
        let repo = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../jsconfig.json")).unwrap();
        let app = jsconfig(Path::new("/apps/shop"), Path::new("/reg/corten-0.1.0/js"));
        assert_eq!(options(&app), options(&repo), "the generated config and jsconfig.json differ");
        assert!(options(&repo).iter().any(|(name, _)| name == "noUncheckedIndexedAccess"));
    }
}
