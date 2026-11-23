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
/// The counts of writes: 65,536 of four bytes, made once with the first page kept and held
/// beside the bound.
const COUNTS: usize = 4 << 16;
/// The marks of the URLs asked for: a bit for every 32 bytes of the bound, made once when the
/// store first fills and held beside the bound too.
const MARKS: usize = BOUND / 256;

#[cfg(feature = "compress")]
const CODINGS: &[&str] = &["identity", "zstd", "br", "gzip"];
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
    text.lines().any(|line| line.starts_with("age:"))
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
    let mut twice = 0;
    for n in 0..PAGES {
        // With room a page is kept the first time it is made. In a full store it is kept from
        // the second request for its URL, so one more comes first.
        let made = !get(&mut stream, &mut read, &format!("/kept?n={n}"), "identity").await;
        assert!(made, "page {n} was asked for the first time");
        for (asked, coding) in CODINGS.iter().enumerate() {
            let given = get(&mut stream, &mut read, &format!("/kept?n={n}"), coding).await;
            if asked == 0 && !given {
                // No store is full before it holds seven answers, the largest being an eighth
                // of the bound. In a full one a new URL's bit is now and then another's, and
                // its page was kept the first time after all.
                assert!(n >= 7, "page {n} was not kept the first time, in a store with room");
                twice += 1;
                let third = get(&mut stream, &mut read, &format!("/kept?n={n}"), coding).await;
                assert!(third, "page {n}: kept by its second request at the latest");
            } else {
                assert!(given, "page {n} in {coding}");
            }
            // The counts are made here, inside what is counted, or taking them off below is wrong.
            if (n, asked) == (0, 0) {
                let first = LIVE.load(Ordering::Relaxed).saturating_sub(before);
                assert!(first >= COUNTS, "the first page kept took {first} bytes: the counts were made before it");
            }
        }
    }
    assert!(twice > PAGES / 2, "{twice} of {PAGES} pages were asked for in a full store");
    let held = LIVE.load(Ordering::Relaxed).saturating_sub(before + COUNTS + MARKS);
    assert!(get(&mut stream, &mut read, &format!("/kept?n={}", PAGES - 1), "identity").await, "the newest is kept");
    assert!(!get(&mut stream, &mut read, "/kept?n=0", "identity").await, "and the oldest went to make room");
    server.abort();
    // The figure `docs/design.md#choice-kept-pages` cites:
    // `cargo test -p corten-run --all-features --test kept_memory -- --nocapture`.
    println!("the kept pages hold {held} bytes under a bound of {BOUND}");
    assert!(held <= BOUND, "the kept pages hold {held} bytes, more than the {BOUND} they are bound to");
    // And the count is not far above what is held, or the app keeps fewer pages than it has room for.
    assert!(held > BOUND * 3 / 4, "the kept pages hold {held} bytes, well under the {BOUND} they may");
}
