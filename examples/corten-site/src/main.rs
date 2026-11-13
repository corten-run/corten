//! Serves the site (`src/lib.rs`). Modules are declared there, not here.

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(corten_site::app()).await
}
