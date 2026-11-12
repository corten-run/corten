//! Names the commit the site was built from, for its certificate and its plates, and whether
//! what it is built from (the site, the crates, the workspace's manifests) had changes that
//! commit does not hold. `CORTEN_SITE_HEAT` in the environment names
//! the commit where there is no checkout to ask (an image build).
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok().filter(|out| out.status.success())?;
    Some(String::from_utf8(out.stdout).ok()?.trim().to_string())
}

/// What a build of the site is made of, from the repository's root. A tree that is partial
/// elsewhere, as an image's build context is, has not changed it.
const BUILT_FROM: [&str; 4] = [":/examples/corten-site", ":/crates", ":/Cargo.toml", ":/Cargo.lock"];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // The site's own files: a change to one is a change the commit does not hold.
    for own in ["src", "locales", "static", "Cargo.toml"] {
        println!("cargo:rerun-if-changed={own}");
    }
    // And the rest of what it is built from.
    for shared in ["../../crates", "../../Cargo.toml", "../../Cargo.lock"] {
        println!("cargo:rerun-if-changed={shared}");
    }
    println!("cargo:rerun-if-env-changed=CORTEN_SITE_HEAT");
    // The checkout's log of where HEAD has been changes with every commit and checkout.
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        println!("cargo:rerun-if-changed={dir}/logs/HEAD");
    }
    let given = std::env::var("CORTEN_SITE_HEAT").ok().filter(|heat| !heat.is_empty());
    let status = [&["status", "--porcelain", "--"][..], &BUILT_FROM[..]].concat();
    let dirty = given.is_none() && git(&status).is_some_and(|changes| !changes.is_empty());
    let commit = given
        .or_else(|| git(&["rev-parse", "--short=7", "HEAD"]))
        .filter(|commit| !commit.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=CORTEN_SITE_HEAT={commit}");
    println!("cargo:rustc-env=CORTEN_SITE_DIRTY={}", if dirty { "1" } else { "" });
}
