use std::process::Command;

#[test]
fn every_command_prints_its_usage_without_running() {
    let commands: &[&[&str]] = &[
        &["new"],
        &["dev"],
        &["build"],
        &["fmt"],
        &["check"],
        &["ui"],
        &["ui", "init"],
        &["ui", "add"],
        &["ui", "list"],
        &["ui", "diff"],
    ];
    let root = std::env::temp_dir().join(format!("corten-command-help-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut failures = Vec::new();
    for command in commands {
        for flag in ["--help", "-h"] {
            // An empty PATH makes accidentally running Cargo fail rather than building the repo.
            let out = Command::new(env!("CARGO_BIN_EXE_corten"))
                .args(*command)
                .arg(flag)
                .current_dir(&root)
                .env("PATH", "")
                .output()
                .unwrap();
            let stdout = String::from_utf8(out.stdout).unwrap();
            let stderr = String::from_utf8(out.stderr).unwrap();
            let usage = format!("Usage:\n  corten {}", command.join(" "));
            if !out.status.success() || !stdout.starts_with(&usage) || !stderr.is_empty() {
                failures.push(format!("{} {flag}: {}\n{stdout}{stderr}", command.join(" "), out.status));
            }
            if *command == ["check"] {
                assert!(!stdout.contains("corten new "), "command help contains unrelated commands");
            }
        }
    }
    let changed = std::fs::read_dir(&root).unwrap().next().is_some();
    std::fs::remove_dir_all(root).unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(!changed, "asking for help wrote files");
}

#[test]
fn help_is_also_recognized_alongside_command_flags() {
    for args in [["check", "--no-script-types", "--help"], ["ui", "add", "-h"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).args(args).output().unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8(out.stdout).unwrap().starts_with("Usage:\n"));
        assert!(out.stderr.is_empty());
    }
}

#[test]
fn help_does_not_make_an_unknown_command_valid() {
    for args in [["unknown", "--help"].as_slice(), &["ui", "unknown", "-h"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).args(args).output().unwrap();
        assert!(!out.status.success());
    }
}

#[test]
fn help_names_a_command_as_its_own_help_does() {
    for command in [["check"].as_slice(), &["build"], &["ui"], &["ui", "add"], &["help"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).arg("help").args(command).output().unwrap();
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert!(out.status.success(), "help {}", command.join(" "));
        assert!(stdout.starts_with(&format!("Usage:\n  corten {}", command.join(" "))), "{stdout}");
        assert!(!stdout.contains("corten new "), "help {} printed every command", command.join(" "));
        assert!(out.stderr.is_empty());
        // The Dockerfile `corten new` writes refuses a `corten` whose `help build` does not name
        // the option (template/Dockerfile), so this command's must.
        assert!(command != ["build"] || stdout.contains("--profile-from"), "{stdout}");
        // And it names `--port` as the profiled build's own, which is refused without it.
        assert!(command != ["build"] || stdout.contains("[[--port <port>] --profile-from <command>"), "{stdout}");
    }
    for flag in ["--help", "-h"] {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).args(["help", flag]).output().unwrap();
        let stdout = String::from_utf8(out.stdout).unwrap();
        assert!(out.status.success(), "help {flag}");
        assert!(stdout.starts_with("Usage:\n  corten help "), "{stdout}");
        assert!(out.stderr.is_empty());
    }
    for command in [["unknown"].as_slice(), &["ui", "unknown"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).arg("help").args(command).output().unwrap();
        assert!(!out.status.success(), "help {} succeeded", command.join(" "));
    }
}

#[test]
fn a_repeated_option_is_refused_and_writes_nothing() {
    // The scan for help reads `--help` here as the second `--name`'s value, so `new` must not run
    // with the first one and write the app.
    let root = std::env::temp_dir().join(format!("corten-repeated-option-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_corten"))
        .args(["new", "shop", "--name", "storefront", "--name", "--help"])
        .current_dir(&root)
        .output()
        .unwrap();
    let changed = std::fs::read_dir(&root).unwrap().next().is_some();
    std::fs::remove_dir_all(root).unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8(out.stderr).unwrap().contains("--name is given more than once"));
    assert!(!changed, "a refused new wrote files");
}

/// `corten build` reads its arguments with its own grammar before help: an argument it refuses
/// is refused, though a `-h` the command after `--profile-from` was given comes later, and a
/// `-h` that command was given is never `corten build`'s.
#[test]
fn build_refuses_a_bad_argument_before_a_later_help() {
    let root = std::env::temp_dir().join(format!("corten-build-help-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for (args, says) in [
        (&["-p", "shop", "--profile-form", "sh", "-h"][..], "not \"--profile-form\""),
        (&["--bin", "--profile-from", "sh", "-h"], "--bin needs a value"),
        (&["--", "--help"], "not \"--\""),
        (&["--port", "http", "--help"], "--port takes the number of the port the app binds"),
        (&["--port", "8443", "--port=8443", "-h"], "--port is given more than once"),
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).arg("build").args(args).current_dir(&root).output().unwrap();
        let stderr = String::from_utf8(out.stderr).unwrap();
        assert!(!out.status.success(), "build {}", args.join(" "));
        assert!(stderr.contains(says), "build {}: {stderr}", args.join(" "));
        assert!(!String::from_utf8(out.stdout).unwrap().contains("Usage:"), "build {}", args.join(" "));
    }
    for args in
        [&["--help"][..], &["--locked", "-p", "shop", "-h"], &["--bin", "--help"], &["--port", "8443", "-h"], &["--port", "-h"]]
    {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).arg("build").args(args).current_dir(&root).output().unwrap();
        assert!(out.status.success(), "build {}", args.join(" "));
        assert!(String::from_utf8(out.stdout).unwrap().starts_with("Usage:\n  corten build "), "build {}", args.join(" "));
    }
    let changed = std::fs::read_dir(&root).unwrap().next().is_some();
    std::fs::remove_dir_all(root).unwrap();
    assert!(!changed, "a refused or help build wrote files");
}

#[test]
fn help_after_a_double_dash_is_still_help_and_writes_nothing() {
    // No command reads `--` as the end of its options, so a flag after it still counts: help
    // there must not let `ui add` replace a file with `--force` or `new` write an app.
    let root = std::env::temp_dir().join(format!("corten-double-dash-help-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for args in
        [["ui", "add", "card", "--", "--help", "--force"].as_slice(), &["new", "shop", "--", "--help", "--name", "storefront"]]
    {
        let out = Command::new(env!("CARGO_BIN_EXE_corten")).args(args).current_dir(&root).env("PATH", "").output().unwrap();
        assert!(out.status.success(), "{}", args.join(" "));
        assert!(String::from_utf8(out.stdout).unwrap().starts_with("Usage:\n"), "{}", args.join(" "));
    }
    let changed = std::fs::read_dir(&root).unwrap().next().is_some();
    std::fs::remove_dir_all(root).unwrap();
    assert!(!changed, "help after -- wrote files");
}
