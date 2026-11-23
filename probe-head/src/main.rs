// Scratch probe for corten-run/corten#1938 (issue #1795), kit 1938c: kit 1938b's probe, unchanged
// but for this line (1938's probe with one config added, `page-roomy`): what a write pays for naming the page it
// changed (`KeptAnswers::changed`), and that requests which do not name one pay nothing. Not part
// of the repository. The same file is built against base and head; on head (feature `named`) the
// handler of `POST /items/7/edit` takes `KeptAnswers` and names the page at `/home` before it
// answers; on base, which has no `KeptAnswers`, the same handler takes nothing. Everything else
// is the same code in both builds.
//
//   <bin> page       the app: a Public page at /home, the named write at /items/7/edit, a write
//                    that names nothing at /items/8/edit, and their reads
//   <bin> page-off   the same app with App::kept_answers(0): no store, so a named write finds none
//   <bin> page-roomy the same app with App::kept_answers(1 GiB): room to keep every new URL a
//                    3 s turn asks for (workload `new`), so none is refused for a full store
//
// Served with `corten::serve` (HOST and PORT from the environment, as an app is), on a
// current-thread runtime, as the earlier probes were, so one pinned CPU runs it all.
// PROBE_ALLOCATOR=jemalloc makes it refuse to start unless jemalloc is the allocator in use.
use corten::prelude::*;
use std::time::Duration;

#[corten::routes]
mod url {
    #[route("/items/7/edit", get = crate::read, post = crate::save_named)]
    pub struct Named;

    #[route("/items/8/edit", get = crate::read, post = crate::save)]
    pub struct Plain;

    #[route("/home", get = crate::home)]
    pub struct Home;
}

async fn read() -> &'static str {
    "item"
}

async fn save() -> &'static str {
    "saved"
}

/// Head: the write names the page it changed, as an app's handler does once its change commits.
#[cfg(feature = "named")]
async fn save_named(kept: corten::KeptAnswers) -> &'static str {
    kept.changed(&url::Home);
    "saved"
}

/// Base: no `KeptAnswers` to take, so the same write names nothing.
#[cfg(not(feature = "named"))]
async fn save_named() -> &'static str {
    "saved"
}

async fn home(req: Req) -> Public<HtmlResult> {
    let page = html! {
        <html lang="en">
            <head>
                <title>"Home"</title>
                <Corten />
            </head>
            <body>
                <main><p>"Request cost probe"</p></main>
            </body>
        </html>
    };
    Public::new(Duration::from_secs(600), req.page(page))
}

/// Refuses to start unless the allocator PROBE_ALLOCATOR names is the one in use.
fn check_allocator() -> Result<(), Box<dyn std::error::Error>> {
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap_or_default();
    let found = if maps.contains("libjemalloc") { "jemalloc" } else { "glibc" };
    eprintln!("ALLOCATOR {found} NAMED {}", cfg!(feature = "named"));
    match std::env::var("PROBE_ALLOCATOR") {
        Ok(asked) if asked != found => Err(format!("PROBE_ALLOCATOR={asked}, but the allocator is {found}").into()),
        _ => Ok(()),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    check_allocator()?;
    let app = App::new(url::router());
    let app = match std::env::args().nth(1).as_deref() {
        Some("page") => app,
        Some("page-off") => app.kept_answers(0),
        Some("page-roomy") => app.kept_answers(1 << 30),
        other => return Err(format!("unknown config {other:?}: page, page-off or page-roomy").into()),
    };
    corten::serve(app).await?;
    Ok(())
}
