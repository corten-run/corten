//! Scratch: a typed `GET /` that answers `served`, served by `corten::serve` on one thread, as
//! design Choice 60 describes the app its counts were made with. Not in the repository.

use corten::App;

#[corten::routes]
mod url {
    #[route("/", get = crate::served)]
    pub struct Home;
}

async fn served() -> &'static str {
    "served"
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    corten::serve(App::new(url::router())).await
}
