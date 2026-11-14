#[cfg(feature = "ssr")]
#[tokio::main]
async fn main() {
    live_parity_leptos::server::serve().await;
}

#[cfg(not(feature = "ssr"))]
fn main() {}
