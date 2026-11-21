//! What the pages the app keeps hold stays within the bound `App::kept_answers` sets, for pages
//! asked for over real HTTP/1.1 connections in every coding (#1780). It counts allocations
//! through this file's global allocator, on every thread, so it runs in a process of its own and
//! is the only test here. The count is the bytes asked of the system allocator: what an allocator
//! rounds a request up to is its own.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use corten::{prelude::*, App, Public};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// The bound the app is given, and more pages than it has room for.
const BOUND: usize = 4 << 20;
const PAGES: usize = 3000;
/// The counts of writes: 65,536 of four bytes, made once with the first page asked for and held
/// beside the bound.
const COUNTS: usize = 4 << 16;

/// A browser's codings: it is given a kept page's brotli at the kept level once that is made, and
/// zstd until then.
#[cfg(feature = "compress")]
const BROWSER: &str = "gzip, deflate, br, zstd";

/// Each coding alone, then a browser's: its answer is the second to a client that takes brotli,
/// so the page's brotli at the kept level is made after it, on the compression thread.
#[cfg(feature = "compress")]
const CODINGS: &[&str] = &["identity", "zstd", "br", "gzip", BROWSER];
#[cfg(not(feature = "compress"))]
const CODINGS: &[&str] = &["identity"];

static LIVE: AtomicUsize = AtomicUsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let at = System.alloc(layout);
        if !at.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        at
    }

    unsafe fn dealloc(&self, at: *mut u8, layout: Layout) {
        System.dealloc(at, layout);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[corten::routes]
mod url {
    #[route("/kept", get = crate::kept)]
    pub struct Kept;

    #[route("/made", get = crate::made)]
    pub struct Made;
}

/// About 5 KB of words that do not repeat, so each coding's bytes are a real page's share of it.
fn document() -> impl corten::Document {
    let words: Vec<String> = (0..600u32).map(|n| (n.wrapping_mul(2_654_435_761) >> 7).to_string()).collect();
    let text = words.join(" ");
    html! {
        <html lang="en">
            <head>
                <title>"Kept"</title>
                <Corten />
            </head>
            <body>
                <main><p>{text}</p></main>
            </body>
        </html>
    }
}

async fn kept(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(600), req.page(document()))
}

/// The same page for one visitor, which is made for every request and never kept.
async fn made(req: Req) -> HtmlResult {
    req.page(document())
}

/// One request as a browser sends it, read to the end of its body. True when the answer was a
/// kept page (it has an `Age`).
async fn get(stream: &mut TcpStream, read: &mut Vec<u8>, path: &str, coding: &str) -> bool {
    answer(stream, read, path, coding).await.0
}

/// [`get`], and the answer's `Content-Encoding`.
async fn answer(stream: &mut TcpStream, read: &mut Vec<u8>, path: &str, coding: &str) -> (bool, Option<String>) {
    let request = format!(
        "GET {path} HTTP/1.1\r\nhost: localhost\r\naccept: text/html,application/xhtml+xml,*/*;q=0.8\r\n\
         accept-language: en-US,en;q=0.9\r\naccept-encoding: {coding}\r\n\
         user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    read.clear();
    let head = loop {
        if let Some(at) = read.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
        assert!(stream.read_buf(read).await.unwrap() > 0, "the connection closed");
    };
    let text = std::str::from_utf8(&read[..head]).unwrap().to_ascii_lowercase();
    assert!(text.starts_with("http/1.1 200"), "{text}");
    let length: usize =
        text.lines().find_map(|line| line.strip_prefix("content-length: ")).expect("a length").trim().parse().unwrap();
    while read.len() < head + length {
        assert!(stream.read_buf(read).await.unwrap() > 0, "the connection closed");
    }
    let encoding = text.lines().find_map(|line| line.strip_prefix("content-encoding: ")).map(|coding| coding.trim().to_owned());
    (text.lines().any(|line| line.starts_with("age:")), encoding)
}

/// Asks for page `n` as a browser until it is given in brotli, which it is once the compression
/// thread has made and counted the page's brotli at the kept level: it was queued on the
/// browser's answer before, and nothing else is queued meanwhile.
#[cfg(feature = "compress")]
async fn made_at_the_kept_level(stream: &mut TcpStream, read: &mut Vec<u8>, n: usize) {
    let asked = std::time::Instant::now();
    loop {
        let (kept, coding) = answer(stream, read, &format!("/kept?n={n}"), BROWSER).await;
        assert!(kept, "page {n} is kept");
        match coding.as_deref() {
            Some("br") => return,
            Some("zstd") => {}
            other => panic!("page {n} in {other:?}"),
        }
        assert!(asked.elapsed() < Duration::from_secs(30), "page {n}'s brotli was not made");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

#[tokio::test]
async fn what_the_kept_pages_hold_stays_within_the_bound() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(corten::serve_on(vec![listener], App::new(url::router()).dev(false).kept_answers(BOUND)));
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut read = Vec::with_capacity(64 << 10);
    // What a request leaves behind that is no kept page (a connection's buffers, each coder's
    // first use) is there before the count starts.
    for n in 0..100 {
        for coding in CODINGS {
            assert!(!get(&mut stream, &mut read, &format!("/made?n={n}"), coding).await);
        }
    }
    let before = LIVE.load(Ordering::Relaxed);
    for n in 0..PAGES {
        for (asked, coding) in CODINGS.iter().enumerate() {
            let given = get(&mut stream, &mut read, &format!("/kept?n={n}"), coding).await;
            assert_eq!(given, asked > 0, "page {n} in {coding}: made once, then given in each coding");
            // The counts are made here, inside what is counted, or taking them off below is wrong.
            if (n, asked) == (0, 0) {
                let first = LIVE.load(Ordering::Relaxed).saturating_sub(before);
                assert!(first >= COUNTS, "the first page asked for took {first} bytes: the counts were made before it");
            }
        }
        // So every page kept holds its brotli at the kept level when the count is read, and the
        // thread has no page's brotli left to make (it frees the encoder's tables before it is
        // given).
        #[cfg(feature = "compress")]
        made_at_the_kept_level(&mut stream, &mut read, n).await;
    }
    // A lookup waits for the store's lock, which the thread holds while it counts the last
    // page's brotli and makes room for it.
    assert!(get(&mut stream, &mut read, &format!("/kept?n={}", PAGES - 1), "identity").await, "the newest is kept");
    let held = LIVE.load(Ordering::Relaxed).saturating_sub(before + COUNTS);
    assert!(!get(&mut stream, &mut read, "/kept?n=0", "identity").await, "and the oldest went to make room");
    server.abort();
    // The figure `docs/design.md#choice-kept-pages` cites:
    // `cargo test -p corten-run --all-features --test kept_memory -- --nocapture`.
    println!("the kept pages hold {held} bytes under a bound of {BOUND}");
    assert!(held <= BOUND, "the kept pages hold {held} bytes, more than the {BOUND} they are bound to");
    // And the count is not far above what is held, or the app keeps fewer pages than it has room for.
    assert!(held > BOUND * 3 / 4, "the kept pages hold {held} bytes, well under the {BOUND} they may");
}
