//! A page kept from a render buffer much larger than it holds its own length and not the buffer
//! (#1824): a page's buffer is sized for the last page rendered, so a small page made after a
//! large one is made in a large buffer. It counts allocations through this file's global
//! allocator, on every thread, so it runs in a process of its own and is the only test here. The
//! count is the bytes asked of the system allocator: what an allocator rounds a request up to is
//! its own.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use corten::{prelude::*, App, Public};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// The small pages kept, each made right after a large one.
const PAGES: usize = 16;

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

    #[route("/large", get = crate::large)]
    pub struct Large;
}

/// A page of `words` words that do not repeat.
fn document(words: u32) -> impl corten::Document {
    let words: Vec<String> = (0..words).map(|n| (n.wrapping_mul(2_654_435_761) >> 7).to_string()).collect();
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

/// About 5 KB, kept.
async fn kept(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(600), req.page(document(600)))
}

/// About 250 KB, made for every request and never kept: the next page's buffer is sized for it.
async fn large(req: Req) -> HtmlResult {
    req.page(document(30_000))
}

/// One request as a browser sends it, read to the end of its body: whether the answer was a kept
/// page (it has an `Age`), and its body.
async fn get(stream: &mut TcpStream, read: &mut Vec<u8>, path: &str) -> (bool, Vec<u8>) {
    let request = format!(
        "GET {path} HTTP/1.1\r\nhost: localhost\r\naccept: text/html,application/xhtml+xml,*/*;q=0.8\r\n\
         accept-language: en-US,en;q=0.9\r\naccept-encoding: identity\r\n\r\n"
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
    (text.lines().any(|line| line.starts_with("age:")), read[head..head + length].to_vec())
}

#[tokio::test]
async fn a_page_made_in_a_larger_buffer_is_kept_at_its_length() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(corten::serve_on(vec![listener], App::new(url::router()).dev(false).kept_answers(64 << 20)));
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut read = Vec::with_capacity(512 << 10);
    // What a request leaves behind that is no kept page (a connection's buffers, the store's
    // counts of writes, made with the first page it keeps) is there before the count starts.
    let (_, large) = get(&mut stream, &mut read, "/large").await;
    assert!(large.len() > 200_000, "the large page is {} bytes", large.len());
    assert!(!get(&mut stream, &mut read, "/kept?n=first").await.0);
    let before = LIVE.load(Ordering::Relaxed);
    let mut length = 0;
    for n in 0..PAGES {
        assert!(!get(&mut stream, &mut read, "/large").await.0);
        let (given, made) = get(&mut stream, &mut read, &format!("/kept?n={n}")).await;
        assert!(!given, "page {n} was made");
        let (given, kept) = get(&mut stream, &mut read, &format!("/kept?n={n}")).await;
        assert!(given && kept == made, "page {n} is given as it was made");
        length = made.len();
    }
    let held = LIVE.load(Ordering::Relaxed).saturating_sub(before);
    server.abort();
    println!("{PAGES} pages of {length} bytes, each made after one of {} bytes, hold {held} bytes", large.len());
    // Each page's bytes and what holds them, and not the buffer of the large page before it.
    assert!(held < PAGES * length * 2, "{PAGES} pages of {length} bytes hold {held} bytes");
}
