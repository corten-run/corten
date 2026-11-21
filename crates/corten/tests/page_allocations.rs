//! How often one request for a page calls the allocator, served by `corten::serve_on` over a
//! keep-alive connection as an app's requests are: a staged page with the default security
//! headers, a layout and an `html!` body of about 4.5 KB, after warm-up (#1779). It counts through
//! this file's global allocator, so it runs in a process of its own and is the only test here.
//! Only the server's thread is counted: the app runs on a current-thread runtime there, and the
//! client, this test's own thread, is not. It pins the mean over the counted requests, not a
//! per-request maximum: one request above the bound passes if the others make up for it.
//!
//! The client's reads and writes time out and the server is shut down and waited for, each within
//! [`WAIT`], so a server that stalls fails the test rather than holding it open.
//!
//! Most of what it counts is not Corten's to take out: hyper's read buffer and its share of it, the
//! answer's header map, the page itself, the boxed futures of the stages and the handler. A change
//! that adds one fails here; one that takes one out lowers the bound with it.

use std::alloc::{GlobalAlloc, Layout as Shape, System};
use std::cell::Cell;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use corten::prelude::*;

/// The most allocations a request may make on average, in a release build and in a debug build
/// alike. With feature `compress` a page's `Vary` gets `accept-encoding` as a second value, which
/// the header map holds apart, so it is one more.
const MOST: usize = if cfg!(feature = "compress") { 20 } else { 19 };

/// How long the client waits for one read or write, and the test for the server to stop.
const WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// The fewest bytes the record page's body may have, well under the 4.4 KB it renders, so a
/// smaller answer fails rather than being counted as a cheaper page.
const LEAST: usize = 4_000;

/// What only the record page has, near its start, middle and end, so another page's `200` fails.
const MARKERS: [&[u8]; 3] = [b"<h1>first</h1>", b"<caption>Record fields</caption>", b">West ridge</a>"];

static ON: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static SERVER: Cell<bool> = const { Cell::new(false) };
}

fn counted(size: usize) {
    if ON.load(Ordering::Relaxed) && SERVER.try_with(Cell::get).unwrap_or(false) {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(size, Ordering::Relaxed);
    }
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, shape: Shape) -> *mut u8 {
        counted(shape.size());
        System.alloc(shape)
    }

    unsafe fn alloc_zeroed(&self, shape: Shape) -> *mut u8 {
        counted(shape.size());
        System.alloc_zeroed(shape)
    }

    unsafe fn realloc(&self, at: *mut u8, shape: Shape, size: usize) -> *mut u8 {
        counted(size);
        System.realloc(at, shape, size)
    }

    unsafe fn dealloc(&self, at: *mut u8, shape: Shape) {
        System.dealloc(at, shape);
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[corten::routes]
mod url {
    #[route("/records/{id}", get = crate::record)]
    pub struct Record<'a> {
        pub id: &'a str,
    }
}

/// A record's fields, as an app's would come from its data.
const FIELDS: [(&str, &str); 24] = [
    ("Access", "North gate, woodland path and open ground."),
    ("Area", "Upper valley, east of the old quarry road."),
    ("Archive", "Shelf 14, box 3, the survey of the second year."),
    ("Boundary", "The stone wall that runs down to the stream."),
    ("Condition", "Dry in summer, soft after rain, steep near the top."),
    ("Direction", "Bear left at the fork and follow the fence line."),
    ("Environment", "Mixed woodland with meadow on the southern slope."),
    ("Feature", "A ruined lime kiln beside the second stile."),
    ("Ground", "Firm clay over limestone, with loose scree in places."),
    ("Habitat", "Hazel coppice, bracken and a damp alder carr."),
    ("Information", "The board at the car park has the current notes."),
    ("Journey", "About two hours there and back at an easy pace."),
    ("Key", "Marked in green on the second sheet of the map."),
    ("Location", "Grid reference held with the survey's first page."),
    ("Material", "Field notes, three photographs and a sketch map."),
    ("Notes", "Recorded in spring, checked again in the autumn."),
    ("Origin", "An old drove road between the two farms."),
    ("Path", "Waymarked throughout, with one unmarked crossing."),
    ("Quality", "Good underfoot except for the last steep section."),
    ("Route", "A loop from the village and back by the river."),
    ("Surface", "Grass, stone and a short stretch of boardwalk."),
    ("Terrain", "Rolling, with one long climb to the ridge."),
    ("Use", "Walkers only; the bridleway joins near the end."),
    ("View", "Across the valley to the hills in the west."),
];

/// The records a record links to.
const RELATED: [(&str, &str); 12] = [
    ("ridge-trail", "Ridge trail"),
    ("valley-survey", "Valley survey"),
    ("woodland-archive", "Woodland archive"),
    ("harbor-notes", "Harbor notes"),
    ("meadow-route", "Meadow route"),
    ("quarry-road", "Quarry road"),
    ("river-loop", "River loop"),
    ("lime-kiln", "Lime kiln"),
    ("drove-road", "Drove road"),
    ("alder-carr", "Alder carr"),
    ("hazel-coppice", "Hazel coppice"),
    ("west-ridge", "West ridge"),
];

#[component]
fn Frame(title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>{title}" | Records"</title>
                <Corten />
            </head>
            <body>
                <header><a href={url::Record { id: "first" }}>"Records"</a></header>
                <main>{children}</main>
            </body>
        </html>
    }
}

async fn record(req: Req, Params(at): Params<url::Record<'_>>) -> HtmlResult {
    let title = &*at.id;
    req.page(html! {
        <Frame title={title}>
            <article aria-label="Record">
                <h1>{title}</h1>
                <p>"Archive entry, surveyed on foot over two seasons."</p>
                <p>
                    "A walking route through the landscape, recorded for the shared catalog. Read the notes "
                    "and related records before setting out: the ground changes with the weather, and the "
                    "crossing below the ridge is closed while the birds nest."
                </p>
                <p>
                    "Recorded for the second survey: the route was walked in both directions, its fields "
                    "checked against the first year's notes, and each stile, gate and crossing marked on "
                    "the sheet. Where the path has moved since the first survey, both lines are kept, the "
                    "older one dashed, so a reader can tell which way the ground has worn. The photographs "
                    "are held with the archive and listed in its index by the number on the back of each, "
                    "and the sketch map is redrawn at the scale of the printed sheet."
                </p>
                <ul aria-label="Tags">
                    for tag in ["survey", "outdoors", "archive", "woodland", "river"] {
                        <li>{tag}</li>
                    }
                </ul>

                <table>
                    <caption>"Record fields"</caption>
                    <tbody>
                        for (name, value) in FIELDS {
                            <tr>
                                <th scope="row">{name}</th>
                                <td>{value}</td>
                            </tr>
                        }
                    </tbody>
                </table>
                <nav aria-label="Related records">
                    <ul>
                        for (id, name) in RELATED {
                            <li><a href={url::Record { id }}>{name}</a></li>
                        }
                    </ul>
                </nav>
            </article>
        </Frame>
    })
}

/// One request on the connection; the answer's body length, once it is checked to be the record
/// page. Allocates nothing unless a check fails.
fn one(stream: &mut std::net::TcpStream, request: &[u8], buf: &mut [u8]) -> usize {
    stream.write_all(request).unwrap();
    let mut len = 0;
    let head = loop {
        let n = stream.read(&mut buf[len..]).unwrap();
        assert!(n > 0, "the server closed the connection");
        len += n;
        if let Some(at) = buf[..len].windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    assert!(buf.starts_with(b"HTTP/1.1 200 "), "{}", String::from_utf8_lossy(&buf[..head]));
    let length = buf[..head]
        .split(|b| *b == b'\n')
        .find_map(|line| line.strip_prefix(b"content-length: "))
        .map(|value| std::str::from_utf8(value).unwrap().trim().parse::<usize>().unwrap())
        .expect("the page says its length");
    while len < head + length {
        let n = stream.read(&mut buf[len..]).unwrap();
        assert!(n > 0, "the server closed the connection");
        len += n;
    }
    assert_eq!(len, head + length, "one answer to one request");
    let body = &buf[head..len];
    assert!(length >= LEAST, "an answer of {length} bytes is not the record page");
    for marker in MARKERS {
        assert!(
            body.windows(marker.len()).any(|w| w == marker),
            "the answer is not the record page: it has no {}",
            String::from_utf8_lossy(marker)
        );
    }
    length
}

#[test]
fn a_page_request_allocates_within_its_bound() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let (stopped, stop) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        SERVER.set(true);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let served = runtime.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            corten::serve_on(vec![listener], App::new(url::router())).await
        });
        let _ = stopped.send(served);
    });
    let mut stream = std::net::TcpStream::connect(addr).unwrap();
    stream.set_nodelay(true).unwrap();
    stream.set_read_timeout(Some(WAIT)).unwrap();
    stream.set_write_timeout(Some(WAIT)).unwrap();
    let request = format!("GET /records/first HTTP/1.1\r\nHost: {addr}\r\nAccept-Encoding: identity\r\n\r\n").into_bytes();
    let mut buf = vec![0; 1 << 16];
    for _ in 0..200 {
        one(&mut stream, &request, &mut buf);
    }
    const REQUESTS: usize = 500;
    ON.store(true, Ordering::SeqCst);
    let mut length = 0;
    for _ in 0..REQUESTS {
        length = one(&mut stream, &request, &mut buf);
    }
    ON.store(false, Ordering::SeqCst);
    let (allocations, bytes) = (ALLOCATIONS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed));
    // The only server in this process (the only test in this file), so stopping every one is safe.
    drop(stream);
    corten::shutdown();
    match stop.recv_timeout(WAIT) {
        Ok(served) => served.expect("the server stops cleanly"),
        Err(error) => panic!("the server did not stop: {error}"),
    }
    // The figure #1779 and the request path's notes cite:
    // `cargo test --release -p corten-run --test page_allocations -- --nocapture`.
    println!(
        "a page of {length} bytes: {} allocations and {} bytes a request",
        allocations as f64 / REQUESTS as f64,
        bytes / REQUESTS
    );
    assert!(
        allocations <= MOST * REQUESTS,
        "a page request allocates {} times on average over {REQUESTS}, more than {MOST}",
        allocations as f64 / REQUESTS as f64
    );
}
