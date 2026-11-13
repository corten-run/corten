//! What the page says in prose that no constant draws, each held to the sentence of the
//! repository it comes from. A document that changes fails the test here, and so does prose that
//! stops saying it; the tables and the figures drawn from them are held in `cert.rs`.

const PERFORMANCE: &str = include_str!("../../../docs/performance.md");
const README: &str = include_str!("../../../README.md");
const DESIGN: &str = include_str!("../../../docs/design.md");
const MANIFEST: &str = include_str!("../../../Cargo.toml");

const CERT: &str = include_str!("cert.rs");
const AFTER: &str = include_str!("after.rs");
const SURFACE: &str = include_str!("surface.rs");
const STEEL: &str = include_str!("steel.rs");
const CORTEN: &str = include_str!("../../../crates/corten/Cargo.toml");

/// The file that says it, what it says, the document, and what the document says.
const HELD: [(&str, &str, &str, &str); 20] = [
    (STEEL, r#"With the Cargo feature " <code>"agent"</code>"#, CORTEN, "agent = ["),
    (
        CERT,
        "2026-11-06 to 2026-11-07, at eea6adb, one DigitalOcean c-8 droplet, Xeon Platinum 8168",
        PERFORMANCE,
        "Measured on one DigitalOcean c-8 droplet (Xeon Platinum 8168) on 2026-11-06 to 2026-11-07 (UTC), three load-test passes (round r16, the tree at `eea6adb`)",
    ),
    (CERT, "On one CPU and 1 GiB", PERFORMANCE, "each with its usual production settings on one CPU and 1 GiB"),
    (CERT, "64 users", PERFORMANCE, "Requests a second are at 64 users"),
    (CERT, "to serve 300 a second", PERFORMANCE, "CPU for 300 pages a second is the fixed-rate phase"),
    (CERT, "requests sent uncompressed", PERFORMANCE, "the load sends uncompressed, untagged requests"),
    (
        CERT,
        "2026-11-11, at 3fb4b1ac, Chromium 156 on Linux, Xeon Platinum 8358",
        PERFORMANCE,
        "Measured in round browser-4 (2026-11-11, at `3fb4b1ac`, on a DigitalOcean c-8 droplet with a Xeon Platinum 8358;",
    ),
    (CERT, "Chromium 156 on Linux", PERFORMANCE, "A table of rows a script changes, in Chromium 156 on Linux."),
    (CERT, "Times run from the click to the DOM being updated", PERFORMANCE, "Times run from the click to the DOM being updated"),
    (
        CERT,
        "takeover from the HTML being parsed to the app marking itself ready",
        PERFORMANCE,
        "Takeover runs from the HTML being parsed to the app marking itself ready",
    ),
    (
        CERT,
        "each app written as its js-framework-benchmark entry is",
        PERFORMANCE,
        "Each framework's app is written the way its keyed [js-framework-benchmark]",
    ),
    (
        CERT,
        "Chromium 148 under the Lighthouse phone profile (4x CPU slowdown, 150 ms round trip, 1.6 Mbps down), median of 10 cold loads",
        PERFORMANCE,
        "loaded cold in Chromium 148 from another site, median of 10 loads each. The phone is the Lighthouse profile: 4x CPU slowdown, 150 ms round trip, 1.6 Mbps down.",
    ),
    (
        CERT,
        "round browser-2 measured 29.5 ms, and reruns of that step 4.9, 20.7 and 6.3 ms",
        PERFORMANCE,
        "round browser-2 measured 29.5 ms for Corten, and three reruns of that step on one CPU model gave 4.9, 20.7 and 6.3 ms",
    ),
    (CERT, "corten-run 0.2", MANIFEST, "version = \"0.2."),
    (SURFACE, "14.6 KB gzipped", README, "A 14.6 KB (gzip) runtime."),
    (
        AFTER,
        "Firefox 147 and later, Safari 26.2 and later",
        DESIGN,
        "Client navigation uses the Navigation API (Chrome, Edge, Firefox 147+, Safari 26.2+)",
    ),
    (
        AFTER,
        "Corten speaks HTTP/1.1",
        README,
        "`corten::serve` speaks HTTP/1.1, so an app with live streams goes behind a proxy or CDN",
    ),
    (AFTER, "You need Rust 1.88 or later", MANIFEST, "rust-version = \"1.88\""),
    (AFTER, "Corten is 0.2: usable and tested", README, "Corten is 0.2: usable and tested, on Rust 1.88 or later"),
    (
        AFTER,
        "the deadline timer that cost 640 ns per request was reworked rather than kept for convenience, and a nicer API that slows every page loses",
        README,
        "the deadline timer that cost 640 ns per request was reworked rather than kept for convenience, and a nicer API that slows every page loses",
    ),
];

/// A text with each run of white space made one space, so a sentence a document wraps is found.
fn flat(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn what_the_page_says_is_what_the_documents_say() {
    for (file, said, document, source) in HELD {
        assert!(flat(file).contains(said), "the page no longer says: {said}");
        assert!(flat(document).contains(source), "no document says: {source}");
    }
}
