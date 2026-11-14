# Getting started

[Back to the guides](../../README.md#documentation)

## Install and create an app

```sh
cargo install corten-cli    # or cargo binstall corten-cli, for the prebuilt binary
npm install --global typescript    # needs Node.js; corten check type-checks the app's scripts with it
corten new my-app
cd my-app
corten dev        # http://localhost:3000, rebuilds on save, open pages reload
```

`cargo binstall` checks the prebuilt binary's download only by HTTPS; to check it against its
build first, download it as in [Verify a prebuilt binary](#verify-a-prebuilt-binary).

`corten new` writes a working app: a page, a form that patches part of the page, a component
with a script, a
test and a Dockerfile.

| Command | What it does |
|---|---|
| `corten new <dir>` | Creates an app that depends on the release matching the command's version, as `corten = { package = "corten-run", version = ".." }`: the package is `corten-run` and the library `corten`, so the app's code names it `corten`. `--name` sets the crate name, `--corten-path` uses a local checkout instead (the repository's root or its `crates/corten`; another directory is refused before anything is written). |
| `corten dev` | Builds and runs the app, rebuilds and restarts on every change in the app's directory or a local package its build reads, like a workspace's shared crate (a failed build keeps the last good server running), and reloads open pages. `--port` or `PORT`. |
| `corten fmt` | Runs `cargo fmt`, then lays out the markup inside `html!`, which rustfmt leaves alone, so it fixes what `corten check` reports (`--check` only reports; given paths, only their markup). |
| `corten check` | `corten fmt --check` (rustfmt's and the markup's), that every component with a stylesheet, script or view is named in a list in its crate or in a member that depends on it, `cargo clippy -D warnings`, `cargo test`, then `tsc` over the app's scripts, after the tests have written `types/app.d.ts`. An app with scripts needs TypeScript installed (`npm install --global typescript`, or in its `package.json`): without `tsc` the check fails rather than pass with the scripts unchecked. `corten check --no-script-types` skips that step and says so, for a machine that cannot run it; the app's CI should not. At a workspace root, each member that depends on `corten` is checked. |
| `corten build` | The release binary. |
| `corten ui init`, `corten ui add <name>..`, `corten ui list` | The [UI kit](kit.md): theme tokens, then styled components copied into `src/ui/` as source the app owns. |

The CLI is a convenience over cargo, not a build system: an app is an ordinary crate, and
`cargo run` works too.

`corten dev`, `fmt` and `check` format and check the way the corten they were built from does, so
they compare it with the one the app's `Cargo.lock` pins (a release, or a git revision): when they
differ, a note before the command's output names both and the `cargo install` line for the
matching command (`--rev` for a pinned revision). `corten ui` prints the note too, since the kit is
the command's own (`ui diff` compares the copies with it), and `corten ui add` and `ui init`
refuse to copy it into such an app: a kit from another corten may not build against the pinned
one, and `--force` would put back components older than the copies it replaces. Install the
matching command, or move the app to the command's corten first. `corten --version` prints the
commit the command was built from; check it after the install, because a target directory that
another revision's install used can hand back that build (with `CARGO_TARGET_DIR` or
`CARGO_BUILD_TARGET_DIR` set, the printed line builds in a directory of its own under it). While
a pin is being bumped (`Cargo.toml` asks for another revision than the lock was written for, until
cargo resolves it), the note compares the command with the revision `Cargo.toml` asks for, and
says nothing for a new tag or branch. A path dependency (a checkout of corten) is not compared.

## Verify a prebuilt binary

The [GitHub releases](https://github.com/corten-run/corten/releases) have `corten-<target>.tgz`
archives (Linux and macOS) and `corten-x86_64-pc-windows-msvc.zip` (Windows). Releases built by
the current workflow include `SHA256SUMS` and GitHub build provenance for every archive; older
releases may have neither. Download your archive and `SHA256SUMS` from the same release into
one directory. Before extracting or running the binary, use the
[GitHub CLI](https://cli.github.com/manual/gh_attestation_verify) (signed in with
`gh auth login`; it reads the attestation through GitHub's API) to verify the archive against
its build, then check its checksum. Substitute your archive's name and the release's tag:

```sh
gh attestation verify corten-x86_64-unknown-linux-musl.tgz -R corten-run/corten \
  --signer-workflow corten-run/corten/.github/workflows/release.yml \
  --source-ref refs/tags/vX.Y.Z
sha256sum -c SHA256SUMS --ignore-missing
```

On macOS, check the checksum with `shasum -a 256 -c --ignore-missing SHA256SUMS`; a `shasum`
too old to know `--ignore-missing` can print the archive's digest with
`shasum -a 256 corten-aarch64-apple-darwin.tgz` to compare with its line in `SHA256SUMS`.

Both checks must succeed. `--ignore-missing` skips the other platforms' archives, not a bad
checksum. The attestation shows that this repository's release workflow built the archive from
that tag. The checksum only shows the archive matches the `SHA256SUMS` downloaded beside it,
which catches a damaged download; it says nothing about who built either file.

In PowerShell, verify provenance the same way and compare the selected archive's checksum:

```powershell
$archive = 'corten-x86_64-pc-windows-msvc.zip'
gh attestation verify $archive -R corten-run/corten `
    --signer-workflow corten-run/corten/.github/workflows/release.yml `
    --source-ref refs/tags/vX.Y.Z
if ($LASTEXITCODE -ne 0) { throw 'Build provenance verification failed' }
$entry = @(Get-Content SHA256SUMS | Where-Object { ($_ -split '  ', 2)[1] -eq $archive })
if ($entry.Count -ne 1) { throw "Expected one checksum for $archive" }
$expected = ($entry[0] -split '  ', 2)[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
    throw "Checksum verification failed for $archive"
}
```

`cargo binstall` does not consume `SHA256SUMS` or GitHub attestations, so today it checks the
download only by HTTPS: its
[supported metadata](https://github.com/cargo-bins/cargo-binstall/blob/main/SUPPORT.md) has no
checksum-file setting, and its [signature support](https://github.com/cargo-bins/cargo-binstall/blob/main/SIGNING.md)
uses minisign, not GitHub attestations, and Corten's releases are not minisign-signed. To verify
a prebuilt binary before installing it,
download and verify it as above, then extract it and put `corten` (`corten.exe` on Windows) in
a directory on your `PATH`. Alternatively, `cargo install corten-cli` builds from the source
crate whose checksum crates.io stores.

## What `corten new` writes

| Path | What |
|---|---|
| `src/lib.rs` | the app: the routes (`#[corten::routes] mod url`), their handlers, `app()` and the tests. A library, so a test target (`tests/`), an example and `main.rs` all reach it; modules are declared here only |
| `src/main.rs` | `main`, which serves `my_app::app()` (the crate's name); it declares no modules, since one declared in both is a second copy of its components, which fails to build |
| `src/views.rs` | the layout (the whole document), the error page and the pages, in `html!` |
| `src/click_counter.js`, `.css` | the `ClickCounter` component's handlers and stylesheet, next to it |
| `static/` | the app's own CSS (element defaults, the layout), its favicon (`favicon.svg`, Corten's mark until you replace it; also answered at `/favicon.ico`), images; compiled into the program (`embed!`, a constant per file) and served at versioned URLs |
| `AGENTS.md` | the rules for an AI agent working on the app |
| `Dockerfile` | a release build in a slim image that preloads jemalloc, which gives back memory a burst of connections took (remove its three lines to run on glibc's allocator); zstd is linked to the build image's libzstd, so the server needs `libzstd.so.1` where it runs (the slim image has it; for one without it, distroless or scratch, remove the `ZSTD_SYS_USE_PKG_CONFIG` line); the build keeps the app's compiled crates in a cache of its own, named for the app, so other apps on the same Docker host build alongside it ([Building the image](deploy.md#building-the-image)); the server runs as an unprivileged user, `USER 10001:10001` (by number, so a cluster that requires non-root containers starts it; the server writes no file, and an app whose server does gives that user a directory) |

## A whole app in one file

Every route is a struct in the routes module, and its attribute names the handler for each method
(`get = home`). Every page is a handler that returns `req.page(document)`, the app's layout
with the page in it. A form with `data-patch` is submitted by the runtime, and its handler
answers with the fragment to replace; without JavaScript the same handler returns the whole page.

```rust,no_run
use corten::prelude::*;

# corten::assets::embed! { pub struct Static = "src/assets/fixture"; }
// The files in `static/`, compiled into the program (`corten new` writes this in `views.rs`):
// corten::assets::embed! { pub struct Static = "static"; }

#[corten::routes]
mod url {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/greet", post = greet)]
    pub struct Greet;
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let app = App::new(url::router()).assets(Static).error_page(error_page, ());
    corten::serve(app).await
}

async fn home(req: Req) -> HtmlResult {
    let name = GreetForm::FIELDS.name;
    req.page(html! {
        <Layout req={&req} title="Home">
            <h1>"Welcome"</h1>
            <form method="post" action={url::Greet} data-patch>
                <input name={name} required>
                <button>"Greet me"</button>
            </form>
            <Greeting name="" />
        </Layout>
    })
}

#[derive(Fields)]
struct GreetForm { name: String }

/// With JavaScript the runtime swaps in the patch; without it the form posts and the whole page
/// comes back. One handler serves both.
async fn greet(req: Req, Form(form): Form<GreetForm>) -> HtmlResult {
    let name = &form.name;
    let page = || async { req.page(html! { <Layout req={&req} title="Home"><Greeting name={name} /></Layout> }) };
    req.patch_or(Greeting { name }, page).await
}

#[derive(Id)]
struct GreetingId;

#[component]
fn Greeting(name: &str) -> impl Patch {
    html! { <p id={GreetingId} aria-live="polite">if !name.is_empty() { "Hello, "{name}"!" }</p> }
}

/// The whole document. `<Corten />` is where Corten adds the runtime and the page's scripts and
/// stylesheets; a client navigation gets only the `<title>` and `<main>`'s children.
#[component]
fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
                <title>{title}</title>
                <Corten />
            </head>
            <body><main>{children}</main></body>
        </html>
    }
}

/// The page for a failed request, in the layout: an unknown URL, a handler's error or panic.
/// `corten new` writes one that names every `Failure`. It takes extractors as a handler does
/// (`viewer: Option<Caller<Viewer>>` to draw it for who is asking).
async fn error_page(failure: Failure, req: Req) -> HtmlResult {
    let title = if matches!(failure, Failure::NotFound) { "Not found" } else { "Something went wrong" };
    req.page(html! { <Layout req={&req} title={title}><h1>{title}</h1></Layout> })
}
```

Handlers are async functions whose arguments are extractors (Corten's `Req`, `Form`, `Caller`,
`State`, ..., or the app's own, `corten::extract`) and whose return type says what the route
answers: `HtmlResult` for a page, a patch or a redirect, `JsonResult<T>` for JSON. The routes
module checks both when the app compiles, and `App` adds everything a production app needs around them. A route names its
handler from where the module is declared (`home` beside `mod url`), so a `use` that brings a
handler in goes above the module; one inside it is a compile error that says so.

Next: [the app's defaults](app.md), then [views](views.md).
