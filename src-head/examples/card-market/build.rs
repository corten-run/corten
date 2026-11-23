//! Builds in the browser test's own routes (`src/smoke.rs`, `cfg(smoke_routes)`) when the `smoke`
//! feature is on (`cargo clippy` and `cargo test --all-features`) or `CARD_MARKET_SMOKE=1` is set
//! while building (the test's image, `--build-arg CARD_MARKET_SMOKE=1`). A deploy's build has
//! neither, so its binary has no such routes to serve.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(smoke_routes)");
    println!("cargo::rerun-if-env-changed=CARD_MARKET_SMOKE");
    let feature = std::env::var_os("CARGO_FEATURE_SMOKE").is_some();
    let asked = std::env::var("CARD_MARKET_SMOKE").is_ok_and(|on| on == "1");
    if feature || asked {
        println!("cargo::rustc-cfg=smoke_routes");
    }
}
