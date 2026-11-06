//! Whether this `corten` command was built from the corten the app builds against: an app pins
//! corten (a git revision or a release) in its `Cargo.lock`, and a command from another one
//! formats and checks the way that one did and carries that one's kit, so `check`, `fmt`, `dev`
//! and `ui` say so first, and `ui add` and `ui init` refuse to copy another corten's kit. While a
//! pin is being bumped, the lock still names the corten the app is leaving until cargo resolves
//! it again, so a `Cargo.toml` that asks for another revision than the lock was written for is
//! what the command is compared with.

use std::{io::Write, path::Path};

/// The commit this command was built from, when known (`build.rs`).
pub const REV: &str = env!("CORTEN_CLI_REV");

/// The framework's package names, its own first: `corten-run`, since `corten` on crates.io is
/// someone else's, and `corten`, which earlier revisions (an app's git pin, an older checkout)
/// were named. The library is `corten` under either, so an app's code names it the same way.
pub const PACKAGES: [&str; 2] = ["corten-run", "corten"];

/// Whether `name` is one of the framework's package names.
pub fn is_framework(name: &str) -> bool {
    PACKAGES.contains(&name)
}

/// The corten an app's `Cargo.lock` names.
#[derive(Debug, PartialEq)]
pub enum Locked {
    /// `git+URL?rev=..#sha`: the repository, the commit, and what `Cargo.toml` asked for when
    /// the lock was written (`rev=8680dd62`, `tag=v0.2`, `branch=main`; empty for the default
    /// branch).
    Git { url: String, sha: String, asked: String },
    /// A release from a registry.
    Release(String),
}

/// The corten packages in a `Cargo.lock` (under either name, [`PACKAGES`]); a path dependency (a
/// checkout of corten itself) names no source, so it is left out.
pub fn locked(lock: &str) -> Vec<Locked> {
    named(lock).into_iter().map(|(_, locked)| locked).collect()
}

/// [`locked`], each with the package name the lock gives it.
fn named(lock: &str) -> Vec<(String, Locked)> {
    let mut found = Vec::new();
    for block in lock.split("[[package]]").skip(1) {
        let field = |key: &str| {
            block.lines().find_map(|line| {
                let value = line.strip_prefix(key)?.trim_start().strip_prefix('=')?.trim();
                Some(value.trim_matches('"').to_string())
            })
        };
        let Some(name) = field("name").filter(|name| is_framework(name)) else { continue };
        let Some(source) = field("source") else { continue };
        if let Some(git) = source.strip_prefix("git+") {
            let Some((url, sha)) = git.split_once('#') else { continue };
            let (url, asked) = url.split_once('?').unwrap_or((url, ""));
            found.push((name, Locked::Git { url: url.to_string(), sha: sha.to_string(), asked: asked.to_string() }));
        } else if let Some(version) = field("version") {
            found.push((name, Locked::Release(version)));
        }
    }
    found
}

/// What a manifest asks of its `corten` git dependencies: each one's URL and `rev=..`, `tag=..`
/// or `branch=..` as the lock records it (empty for the default branch). Empty when it has none
/// (a release, `workspace = true`, no corten). Reads the shapes cargo takes: an inline table, on
/// one line or several; a `[dependencies.corten]` table under any dependency kind, the workspace
/// or a target; dotted keys (`corten.rev = ".."`); a key that is either package name or names one
/// (`package = "corten-run"`, [`PACKAGES`]); either kind of quote; and comments.
pub fn asked(manifest: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    // The current table's dependency, when the header names one (`[dependencies.corten]`).
    let mut table: Option<(String, Vec<(String, String)>)> = None;
    let mut in_deps = false;
    let mut deps: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for entry in entries(manifest) {
        match entry {
            Entry::Header(path) => {
                if let Some(t) = table.take() {
                    deps.push(t);
                }
                let kind = |p: &str| matches!(p, "dependencies" | "dev-dependencies" | "build-dependencies");
                in_deps = path.last().is_some_and(|p| kind(p));
                if path.len() >= 2 && kind(&path[path.len() - 2]) {
                    table = Some((path[path.len() - 1].clone(), Vec::new()));
                }
            }
            Entry::Pair(key, value) => {
                if let Some((_, keys)) = &mut table {
                    keys.push((key.join("."), value));
                } else if in_deps && key.len() == 1 {
                    deps.push((key[0].clone(), inline(&value)));
                } else if in_deps && key.len() == 2 {
                    match deps.iter_mut().find(|(name, _)| *name == key[0]) {
                        Some((_, keys)) => keys.push((key[1].clone(), value)),
                        None => deps.push((key[0].clone(), vec![(key[1].clone(), value)])),
                    }
                }
            }
        }
    }
    deps.extend(table);
    for (name, keys) in deps {
        let get = |k: &str| keys.iter().find(|(key, _)| key == k).map(|(_, v)| unquote(v));
        if !is_framework(get("package").as_deref().unwrap_or(&name)) {
            continue;
        }
        let Some(url) = get("git") else { continue };
        let asked = ["rev", "tag", "branch"].iter().find_map(|kind| get(kind).map(|v| format!("{kind}={v}"))).unwrap_or_default();
        found.push((url, asked));
    }
    found
}

/// A line of a manifest: a table's header, or a key (dotted, as its parts) and its value as written.
enum Entry {
    Header(Vec<String>),
    Pair(Vec<String>, String),
}

/// The manifest's headers and pairs, without comments; a value that opens a bracket runs to the
/// line that closes it.
fn entries(manifest: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut lines = manifest.lines().map(uncomment);
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.starts_with('[') {
            let inner = line.trim_start_matches('[').trim_end_matches(']');
            out.push(Entry::Header(dotted(inner)));
            continue;
        }
        let Some((key, value)) = split_pair(line) else { continue };
        let mut value = value.trim().to_string();
        while depth(&value) > 0 {
            let Some(next) = lines.next() else { break };
            value.push(' ');
            value.push_str(next.trim());
        }
        out.push(Entry::Pair(dotted(key), value));
    }
    out
}

/// `line` up to a `#` outside quotes.
fn uncomment(line: &str) -> String {
    let mut quote = None;
    for (i, c) in line.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '#') => return line[..i].to_string(),
            _ => {}
        }
    }
    line.to_string()
}

/// `key = value` at the first `=` outside quotes.
fn split_pair(text: &str) -> Option<(&str, &str)> {
    let mut quote = None;
    for (i, c) in text.char_indices() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '=') => return Some((&text[..i], &text[i + 1..])),
            _ => {}
        }
    }
    None
}

/// How many brackets `value` leaves open, outside quotes.
fn depth(value: &str) -> i32 {
    let (mut depth, mut quote) = (0, None);
    for c in value.chars() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '{' | '[') => depth += 1,
            (None, '}' | ']') => depth -= 1,
            _ => {}
        }
    }
    depth
}

/// A dotted key or header (`target.'cfg(windows)'.dependencies.corten`) as its parts.
fn dotted(key: &str) -> Vec<String> {
    let (mut parts, mut part, mut quote) = (Vec::new(), String::new(), None);
    for c in key.chars() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '.') => parts.push(std::mem::take(&mut part).trim().to_string()),
            _ => part.push(c),
        }
    }
    parts.push(part.trim().to_string());
    parts
}

/// The pairs of an inline table, `{ git = "..", rev = ".." }`; nothing for any other value.
fn inline(value: &str) -> Vec<(String, String)> {
    let Some(inner) = value.trim().strip_prefix('{').and_then(|v| v.strip_suffix('}')) else { return Vec::new() };
    let (mut pairs, mut start, mut level, mut quote) = (Vec::new(), 0, 0, None);
    for (i, c) in inner.char_indices().chain([(inner.len(), ',')]) {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), _) if c == q => quote = None,
            (None, '{' | '[') => level += 1,
            (None, '}' | ']') => level -= 1,
            (None, ',') if level == 0 => {
                if let Some((key, value)) = split_pair(&inner[start..i]) {
                    pairs.push((dotted(key).join("."), value.trim().to_string()));
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    pairs
}

/// A string value without its quotes.
fn unquote(value: &str) -> String {
    let value = value.trim();
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner.to_string();
        }
    }
    value.to_string()
}

/// A lock's query as cargo writes it, `branch=codex%2Fpin-bump`, decoded.
fn decoded(query: &str) -> String {
    let bytes = query.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(hi), Some(lo)) => {
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            (b, _, _) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What to tell the user when this command (`version`, built from `rev`) is not the one for
/// `locked`: what differs and the command that installs the matching one. `None` when they
/// match, or when this command's commit is not known. With a `target` directory the user set for
/// cargo, a git install builds in one of its own under it: cargo can hand back another revision's
/// build in a shared one as fresh.
pub fn mismatch(locked: &Locked, version: &str, rev: &str, target: Option<&Path>) -> Option<String> {
    let short = |sha: &str| sha.get(..8).unwrap_or(sha).to_string();
    match locked {
        Locked::Git { url, sha, .. } if !rev.is_empty() && !sha.starts_with(rev) && !rev.starts_with(sha.as_str()) => {
            let (own, why) = match target {
                Some(target) => {
                    let own = target.join(format!("corten-cli-{}", short(sha))).display().to_string();
                    let own = if own.contains(char::is_whitespace) { format!("\"{own}\"") } else { own };
                    (
                        format!(" --target-dir {own}"),
                        "a target directory another revision's install used can hand back that build",
                    )
                }
                None => (
                    String::new(),
                    "a target directory another revision's install used can hand back that build, so give this one a --target-dir of its own",
                ),
            };
            Some(format!(
                // The whole commit: cargo finds a short one only among the branches and tags it fetches.
                "this corten command was built from corten {}, and the app builds against {}, so fmt, check and the kit it carries may not be that one's. Install the matching command:\n  cargo install --git {url} --rev {sha} corten-cli --locked{own}\nand check that corten --version names {}: {why}",
                short(rev),
                short(sha),
                short(sha)
            ))
        }
        Locked::Release(release) if release != version => Some(format!(
            "this corten command is {version}, and the app builds against corten {release}, so fmt, check and the kit it carries may not be that one's. Install the matching command:\n  cargo install corten-cli --version {release} --locked"
        )),
        _ => None,
    }
}

/// The lock's git pin as `Cargo.toml` asks for it now (`asked`, from [`asked`]): unchanged when
/// the manifest names nothing or one of its corten dependencies asks for what the lock was
/// written for; while a pin is being bumped, the commit the manifest asks for (with its URL), and
/// `None` when that is a tag, a branch or a ref whose commit is not known until cargo resolves it.
pub fn as_asked(locked: Locked, asked: &[(String, String)]) -> Option<Locked> {
    let Locked::Git { asked: was, .. } = &locked else { return Some(locked) };
    if asked.is_empty() || asked.iter().any(|(_, now)| *now == decoded(was)) {
        return Some(locked);
    }
    let (url, now) = &asked[0];
    let sha = now.strip_prefix("rev=").filter(|rev| rev.len() >= 7 && rev.chars().all(|c| c.is_ascii_hexdigit()))?;
    Some(Locked::Git { url: url.clone(), sha: sha.to_string(), asked: now.clone() })
}

/// Prints a note when the app in `root` (or the workspace above it) pins another corten.
pub fn warn(root: &Path) {
    if let Some(note) = note(root, env!("CARGO_PKG_VERSION"), REV, target().as_deref()) {
        // A note: a closed stderr fails nothing.
        let _ = writeln!(std::io::stderr(), "corten: note: {}\n", note.text);
    }
}

/// The target directory the user set for cargo in the environment (`CARGO_TARGET_DIR`, or
/// `CARGO_BUILD_TARGET_DIR`), where another revision's install may have left a build cargo hands
/// back as fresh. One set in a cargo config file (`build.target-dir`) is not read.
pub fn target() -> Option<std::path::PathBuf> {
    ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR"]
        .into_iter()
        .find_map(|name| std::env::var_os(name).filter(|dir| !dir.is_empty()))
        .map(Into::into)
}

/// A command that is not the app's pin: what to tell the user, and how the app would name this
/// command's corten instead.
#[derive(Debug, PartialEq)]
pub struct Note {
    /// [`mismatch`]'s text.
    pub text: String,
    /// What the app's `Cargo.toml` asks for to build against this command's corten:
    /// `package = "corten-run", rev = "<whole commit>"` or `package = "corten-run", version = "0.2.0"`.
    pub this: String,
    /// The package name the lock gives the pin (`corten` before the rename), which
    /// `cargo update -p` takes.
    pub package: String,
}

/// What to tell the user when the app in `root` (or the workspace above it) pins another corten
/// than a command of `version`, built from `rev`, as [`mismatch`] says it. With a shared
/// `target` directory, the install line builds in a directory of its own under it, since cargo can
/// hand back another revision's build there as fresh.
pub fn note(root: &Path, version: &str, rev: &str, target: Option<&Path>) -> Option<Note> {
    let lock = root.ancestors().map(|dir| dir.join("Cargo.lock")).find(|path| path.is_file())?;
    let text = std::fs::read_to_string(&lock).ok()?;
    // What the manifests between here and the lock ask for (the nearest that names corten).
    let top = lock.parent().unwrap_or(root);
    let asked = root
        .ancestors()
        .take_while(|dir| dir.starts_with(top))
        .filter_map(|dir| std::fs::read_to_string(dir.join("Cargo.toml")).ok())
        .map(|manifest| asked(&manifest))
        .find(|asked| !asked.is_empty())
        .unwrap_or_default();
    let locked: Vec<(String, Locked)> =
        named(&text).into_iter().filter_map(|(name, l)| Some((name, as_asked(l, &asked)?))).collect();
    if locked.iter().any(|(_, l)| mismatch(l, version, rev, target).is_none()) {
        return None;
    }
    let (package, first) = locked.first()?;
    let text = mismatch(first, version, rev, target)?;
    // This command's corten is named as this revision names it.
    let own = PACKAGES[0];
    let this = match first {
        Locked::Git { .. } => format!("package = \"{own}\", rev = \"{rev}\""),
        // Which this command is, a release or a git checkout, is not known here.
        Locked::Release(_) if rev.is_empty() => format!("package = \"{own}\", version = \"{version}\""),
        Locked::Release(_) => format!(
            "package = \"{own}\" with version = \"{version}\" if this command is that release, or with git = corten's repository and rev = \"{rev}\""
        ),
    };
    Some(Note { text, this, package: package.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCK: &str = r#"
[[package]]
name = "axum"
version = "0.8.4"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "corten"
version = "0.1.0"
source = "git+https://github.com/corten-run/corten?rev=8680dd62#8680dd620abceb65da75017a21456aa28977b832"
dependencies = [
 "axum",
]

[[package]]
name = "corten-macros"
version = "0.1.0"
source = "git+https://github.com/corten-run/corten?rev=8680dd62#8680dd620abceb65da75017a21456aa28977b832"
"#;

    #[test]
    fn a_pinned_revision_is_read_from_the_lock() {
        let sha = "8680dd620abceb65da75017a21456aa28977b832";
        assert_eq!(
            locked(LOCK),
            [Locked::Git { url: "https://github.com/corten-run/corten".into(), sha: sha.into(), asked: "rev=8680dd62".into() }]
        );
        let release = "[[package]]\nname = \"corten-run\"\nversion = \"0.2.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
        assert_eq!(locked(release), [Locked::Release("0.2.0".into())]);
        // A pin from before the rename names the package corten; another crate of the name is not it.
        assert_eq!(locked(&release.replace("corten-run", "corten")), [Locked::Release("0.2.0".into())]);
        assert_eq!(locked(&release.replace("corten-run", "corten-ui")), Vec::<Locked>::new());
        // A checkout of corten itself (a path dependency) names no source.
        assert_eq!(locked("[[package]]\nname = \"corten-run\"\nversion = \"0.1.0\"\n"), Vec::<Locked>::new());
    }

    /// The note names the package as the lock does, for `cargo update -p`, and this command's
    /// corten under its own name.
    #[test]
    fn the_note_names_the_pin_as_the_lock_does_and_this_command_as_it_is_named() {
        let dir = std::env::temp_dir().join(format!("corten-pin-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rev = "dd028b94ad0f63d687ef65b157117fa53caab41c";
        for (name, expected) in [("corten", "corten"), ("corten-run", "corten-run")] {
            std::fs::write(dir.join("Cargo.lock"), LOCK.replacen("name = \"corten\"", &format!("name = \"{name}\""), 1)).unwrap();
            let note = note(&dir, "0.2.0", rev, None).expect("another commit");
            assert_eq!(note.package, expected);
            assert_eq!(note.this, format!("package = \"corten-run\", rev = \"{rev}\""));
        }
        let release = "[[package]]\nname = \"corten\"\nversion = \"0.1.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
        std::fs::write(dir.join("Cargo.lock"), release).unwrap();
        assert_eq!(note(&dir, "0.2.0", "", None).expect("another release").this, "package = \"corten-run\", version = \"0.2.0\"");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn another_corten_says_which_and_how_to_install_the_matching_command() {
        let pinned = &locked(LOCK)[0];
        assert_eq!(mismatch(pinned, "0.1.0", "8680dd620abceb65da75017a21456aa28977b832", None), None);
        let note = mismatch(pinned, "0.1.0", "dd028b94ad0f63d687ef65b157117fa53caab41c", None).expect("another commit");
        assert!(note.contains("built from corten dd028b94, and the app builds against 8680dd62"), "{note}");
        assert!(
            note.contains("\n  cargo install --git https://github.com/corten-run/corten --rev 8680dd620abceb65da75017a21456aa28977b832 corten-cli --locked\n"),
            "{note}"
        );
        // Installing through a target directory another revision's install used can hand back
        // that build, so the note says how to tell and how to avoid it.
        assert!(note.contains("check that corten --version names 8680dd62"), "{note}");
        assert!(note.ends_with("give this one a --target-dir of its own"), "{note}");
        // Built where the commit is not known: nothing to compare.
        assert_eq!(mismatch(pinned, "0.1.0", "", None), None);
        let release = Locked::Release("0.2.0".into());
        assert!(
            mismatch(&release, "0.1.0", "", None)
                .expect("another release")
                .ends_with("cargo install corten-cli --version 0.2.0 --locked")
        );
        assert_eq!(mismatch(&release, "0.2.0", "", None), None);
    }

    const URL: &str = "https://github.com/corten-run/corten";

    fn one(url: &str, asked: &str) -> Vec<(String, String)> {
        vec![(url.to_string(), asked.to_string())]
    }

    #[test]
    fn a_manifest_says_what_it_asks_of_corten_in_any_shape_cargo_takes() {
        let rev = one(URL, "rev=ab31954a");
        for manifest in [
            "[dependencies]\ncorten = { git = \"https://github.com/corten-run/corten\", rev = \"ab31954a\", features = [\"json\"] }\ncorten-ui = { git = \"https://github.com/corten-run/corten\", rev = \"0000000\" }\n",
            "[dependencies]\ncorten = { git = \"https://github.com/corten-run/corten\", rev = \"ab31954a\" } # keep in sync\n",
            "[dependencies]\ncorten = { git = 'https://github.com/corten-run/corten', rev = 'ab31954a' }\n",
            "[dependencies]\ncorten = {\n  git = \"https://github.com/corten-run/corten\", # the repository\n  rev = \"ab31954a\",\n}\n",
            "[dependencies]\ncorten.git = \"https://github.com/corten-run/corten\"\ncorten.rev = \"ab31954a\" # pinned\n",
            "[target.'cfg(windows)'.dependencies.corten]\ngit = \"https://github.com/corten-run/corten\"\nrev = \"ab31954a\"\n",
            "[dependencies]\nweb = { package = \"corten\", git = \"https://github.com/corten-run/corten\", rev = \"ab31954a\" }\n",
            "[dependencies]\ncorten = { package = \"corten-run\", git = \"https://github.com/corten-run/corten\", rev = \"ab31954a\" }\n",
            "[dependencies]\ncorten-run = { git = \"https://github.com/corten-run/corten\", rev = \"ab31954a\" }\n",
            "[workspace.dependencies.corten]\ngit = \"https://github.com/corten-run/corten\"\nrev = \"ab31954a\"\n\n[dependencies]\nserde = \"1\"\n",
            "[dependencies]\r\ncorten = { git = \"https://github.com/corten-run/corten\", rev = \"ab31954a\" }\r\n",
        ] {
            assert_eq!(asked(manifest), rev, "{manifest}");
        }
        let tag = "[workspace.dependencies.corten]\ngit = \"https://github.com/corten-run/corten\"\ntag = \"v0.2.0\"\n";
        assert_eq!(asked(tag), one(URL, "tag=v0.2.0"));
        assert_eq!(asked("[dependencies]\ncorten = { git = \"https://github.com/corten-run/corten\" }\n"), one(URL, ""));
        // A release, a member that takes the workspace's, another crate, or a key in a comment.
        for none in [
            "[dependencies]\ncorten = \"0.2\"\n",
            "[dependencies]\ncorten = { workspace = true }\n",
            "[dependencies]\nserde = { version = \"1\", git = \"x\", rev = \"x\" }\n",
            "[dependencies]\ncorten = { package = \"corten-ui\", git = \"x\", rev = \"x\" }\n",
            "[package]\nname = \"app\" # corten = { git = \"x\" }\n",
        ] {
            assert_eq!(asked(none), Vec::<(String, String)>::new(), "{none}");
        }
    }

    #[test]
    fn during_a_pin_bump_the_command_is_compared_with_what_the_manifest_asks_for() {
        let pinned = || locked(LOCK).remove(0);
        // The manifest asks what the lock was written for (or names nothing): the lock's commit.
        assert_eq!(as_asked(pinned(), &one(URL, "rev=8680dd62")), Some(pinned()));
        assert_eq!(as_asked(pinned(), &[]), Some(pinned()));
        // One of several asks for it (a dev-dependency still at the old pin): still the lock's.
        let both = [one(URL, "rev=0123abcd"), one(URL, "rev=8680dd62")].concat();
        assert_eq!(as_asked(pinned(), &both), Some(pinned()));
        // Bumped to ab31954a, the lock not resolved yet: a command built from ab31954a says nothing,
        // and another one is told to install ab31954a, not the commit the app is leaving.
        let bumped = as_asked(pinned(), &one(URL, "rev=ab31954a")).expect("a revision");
        assert_eq!(mismatch(&bumped, "0.1.0", "ab31954a1b2c3d4e5f60718293a4b5c6d7e8f901", None), None);
        let note = mismatch(&bumped, "0.1.0", "dd028b94ad0f63d687ef65b157117fa53caab41c", None).expect("another commit");
        assert!(note.contains(&format!("--git {URL} --rev ab31954a corten-cli --locked\n")), "{note}");
        // Moved to a fork: its URL with its commit.
        let fork = as_asked(pinned(), &one("https://github.com/someone/corten", "rev=ab31954a")).expect("a revision");
        assert!(
            mismatch(&fork, "0.1.0", "dd028b94", None)
                .unwrap()
                .contains("--git https://github.com/someone/corten --rev ab31954a")
        );
        // Bumped to a tag, a branch or a ref: its commit is not known until cargo resolves it.
        for now in ["tag=v0.2.0", "branch=main", "", "rev=refs/pull/476/head"] {
            assert_eq!(as_asked(pinned(), &one(URL, now)), None, "{now}");
        }
    }

    #[test]
    fn a_lock_written_for_a_branch_with_a_slash_is_the_manifests_branch() {
        // Cargo writes the query percent-encoded.
        let lock = "[[package]]\nname = \"corten\"\nversion = \"0.1.0\"\nsource = \"git+https://github.com/corten-run/corten?branch=codex%2Fpin-bump#8680dd620abceb65da75017a21456aa28977b832\"\n";
        let pinned = locked(lock).remove(0);
        assert_eq!(as_asked(locked(lock).remove(0), &one(URL, "branch=codex/pin-bump")), Some(pinned));
        assert_eq!(decoded("tag=v0.2%2Bx"), "tag=v0.2+x");
    }
}
