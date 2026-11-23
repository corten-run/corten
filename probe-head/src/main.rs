// Scratch probe for corten-run/corten#1846 (a kept page's, JSON's or text's brotli 5): paired cycles
// on a quiet host. Not part of the repository. 1846r5: 1846r4's probe with the `twice` config and the
// in-process `cg` mode (both below), and `main` building its runtime itself (as #[tokio::main] did)
// so that `cg` can build its own; every other config serves as in 1846r4. The same program is built against the base and the
// head trees (probe-base, probe-head); only the Cargo package, the bin name and the path to corten
// differ. The earlier kit's probe (1846/probe-*/src/main.rs) with two changes: `refused` waits for
// the compression thread with a fence (below) instead of 300 ms (1846r), and a panic anywhere in the
// process before its port opens, one the compression thread caught included, stops the start
// (1846r2: a caught panic in /page's job would also leave it given its kept zstd 1, so without
// this the fence and the WARM line could not tell it from the budget's refusal).
//
// Usage: <bin> <port> <config> [bound fill]
//   browser   a kept Public /page, warmed with a browser's Accept-Encoding (zstd, br, gzip) four
//             times, so it is kept, its zstd 1 made and, on #1846's head, its brotli 5 made
//   gzip      the same, warmed with Accept-Encoding: gzip
//   refused   <bound> <fill>: kept_answers(bound); <fill> other pages (/page?fill=<n>, uncompressed,
//             each asked twice) kept first, then /page warmed as in browser: with a bound found by
//             calibrate-refused.sh, the page and its zstd fit and its brotli 5 does not. Then the
//             fence: a second app in this process (its own store, 1 MiB) keeps /mark, a 1.6 KB page,
//             and is asked for it twice with a browser's Accept-Encoding, which on the head queues
//             its brotli 5 on the one compression thread behind /page's; the thread takes a kept
//             page's jobs in the order they were queued, so once /mark answers br (polled every
//             millisecond, 10 s at most, else the probe exits) /page's job has run to its end:
//             made, and given room or not. The base has no such job (its kept pages have no brotli
//             5): it asks /mark the same twice and once more and requires zstd from it. Then no
//             panic may have been seen (PANICS, counted by a hook every panic runs, caught or not),
//             else FENCE FAILED. Logged as FENCE before the WARM line, which then shows whether
//             /page is still given zstd: kept zstd after a closed fence and no panic is the
//             budget's refusal, the job having run to its end and put nothing with the page.
//   new       kept_answers(8 GiB), nothing warmed: every new URL is kept with room
//   hit       /page warmed twice with no Accept-Encoding (as wrk asks), so it is kept
//   off       kept_answers(0): /page is Public and nothing is kept
//   private   the default app; /private is the same page, not Public
//   json-browser  a kept Public JSON body (/records, 1,999 bytes), warmed four times with a data
//             client's Accept (application/json) and a browser's Accept-Encoding, so it is kept, its
//             zstd 1 made and, on #1846's head, its brotli 5 made
//   json-new  kept_answers(8 GiB), nothing warmed: every new URL of /records is kept with room
//   json-hit  /records warmed twice with Accept: application/json and no Accept-Encoding, so kept
//   twice     kept_answers(8 GiB), /page warmed as in browser (so on the head the compression
//             thread is started and /page's brotli 5 made before the port opens): the load asks
//             every new URL twice (lua/twice-browser.lua), the second answer queueing its brotli 5
//             on the head, which the compression thread then makes on the server's CPU
//
// <bin> cg <first|second> <warm|cold> <urls>: in process, for Callgrind (no port; see `cg`).
// /records is the JSON body #1846's tests/kept_coding_cost.rs keeps (its KEPT_ROUTE=json): the
// record's 24 fields as [name, note] pairs. Every request to it in a warm-up says
// Accept: application/json, as the load scripts for it do.
// While a warm-up runs, the port is bound but not served: a connection waits until the warm-up
// is done (its requests go to a listener of their own on another port). PROBE_ALLOCATOR=jemalloc
// (or glibc) makes the probe refuse to start unless /proc/self/maps shows that allocator.
// Every config: a panic seen before the port opens prints PANICKED and exits before the WARM line.
use corten::prelude::*;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// Panics in this process so far, counted by the hook `main` installs before anything runs. The
/// hook runs for a panic `catch_unwind` then catches too (the compression thread's jobs).
static PANICS: AtomicUsize = AtomicUsize::new(0);

#[corten::routes]
mod url {
    #[route("/page", get = crate::record)]
    pub struct Record;

    #[route("/private", get = crate::private)]
    pub struct Plain;

    #[route("/records", get = crate::records)]
    pub struct Records;

    #[route("/mark", get = crate::mark)]
    pub struct Mark;
}

const NAMES: [&str; 24] = [
    "Access", "Area", "Archive", "Boundary", "Condition", "Direction", "Environment", "Feature", "Ground", "Habitat",
    "Information", "Journey", "Key", "Location", "Material", "Notes", "Origin", "Path", "Quality", "Route", "Surface",
    "Terrain", "Use", "View",
];

/// Stage, distance, surface and a note, for the record's table.
const STAGES: [(&str, &str, &str, &str); 20] = [
    ("North gate to the old mill", "1.2 km", "Gravel", "Level; the mill race is fenced on the left."),
    ("Old mill to Larch bridge", "0.8 km", "Packed earth", "Wet after rain; boards over the two soft stretches."),
    ("Larch bridge to the beech wood", "1.5 km", "Earth and roots", "Steady climb of 60 m; benches at the bend."),
    ("Through the beech wood", "2.1 km", "Leaf litter", "Waymarked every 200 m; keep to the upper path."),
    ("Beech wood to Hollins farm", "0.9 km", "Farm track", "Gates to close behind you; cattle from May."),
    ("Hollins farm to the ridge stile", "1.1 km", "Grass", "Steepest part of the route, 110 m of ascent."),
    ("Along the ridge, west", "2.6 km", "Short turf", "Open ground with views north; exposed in wind."),
    ("Ridge cairn to the trig point", "0.7 km", "Stony", "Loose stones near the top; the pillar is 412 m."),
    ("Trig point to Saddle pool", "1.4 km", "Peat", "Boggy in winter; flagstones laid across the worst."),
    ("Saddle pool to the larch plantation", "1.0 km", "Forest road", "Timber lorries on weekdays; walk facing traffic."),
    ("Through the plantation", "1.8 km", "Forest road", "Shade all day; the road forks twice, keep right."),
    ("Plantation edge to Greystone", "1.3 km", "Lane", "Quiet lane between walls; passing places only."),
    ("Greystone to the chapel", "0.6 km", "Pavement", "Through the village; shop and water tap by the green."),
    ("Chapel to the river path", "0.9 km", "Gravel", "Steps down to the river; a ramp avoids them."),
    ("River path, downstream", "2.4 km", "Earth", "Floods at the meadow in spate; a high path is signed."),
    ("Weir to the stepping stones", "0.5 km", "Earth", "The stones are impassable in high water; use the footbridge."),
    ("Stepping stones to Lower wood", "1.0 km", "Grass", "Gentle rise across two fields; dogs on leads."),
    ("Lower wood to the quarry", "1.2 km", "Old track", "The quarry edge is fenced; keep to the track."),
    ("Quarry to the reservoir dam", "1.6 km", "Tarmac path", "Shared with cyclists; the dam is crossed on its crest."),
    ("Reservoir dam to the north gate", "1.9 km", "Gravel", "Returns along the east shore to the start."),
];

/// A record page of about 6 KB: a heading, a description, a definition list and a table.
fn document() -> impl corten::Document {
    html! {
        <html lang="en">
            <head>
                <title>"Ridge trail 7"</title>
                <Corten />
            </head>
            <body>
                <header>
                    <p>"Shared catalog of walking routes"</p>
                </header>
                <main>
                    <h1>"Ridge trail 7"</h1>
                    <p>"Archive entry 7, recorded 2026-10-03, last walked 2026-11-14."</p>
                    <p>
                        "A circular walking route through the landscape north of Greystone, recorded for the shared catalog. It climbs from the north gate through the beech wood to the ridge, follows the ridge west to the trig point and returns by the plantation, the village and the river. Read the notes and related records before setting out."
                    </p>
                    <dl>
                        for name in NAMES {
                            <div>
                                <dt>{name}</dt>
                                <dd>{name}" notes for entry 7: North gate, woodland path and open ground."</dd>
                            </div>
                        }
                    </dl>
                    <h2>"Stages"</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>"Stage"</th>
                                <th>"Distance"</th>
                                <th>"Surface"</th>
                                <th>"Notes"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for stage in STAGES {
                                <tr>
                                    <td>{stage.0}</td>
                                    <td>{stage.1}</td>
                                    <td>{stage.2}</td>
                                    <td>{stage.3}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </main>
            </body>
        </html>
    }
}

/// Kept for a day, so no lifetime ends during a run.
async fn record(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(86_400), req.page(document()))
}

async fn private(req: Req) -> HtmlResult {
    req.page(document())
}

/// The record's fields as JSON (1,999 bytes), kept for a day: #1846's kept_coding_cost.rs body.
async fn records() -> Public<JsonResult<Vec<(String, String)>>> {
    let rows: Vec<(String, String)> = NAMES
        .iter()
        .map(|name| (name.to_string(), format!("{name} notes for entry 7: North gate, woodland path and open ground.")))
        .collect();
    let rows: JsonResult<Vec<(String, String)>> = Ok(Json(rows));
    Public::new(Duration::from_secs(86_400), rows)
}

/// A small page, kept by the fence's app of its own (`refused`): tests/kept_memory.rs's `/mark`.
async fn mark(req: Req) -> Public<HtmlResult> {
    let text = "mark ".repeat(300);
    let page = html! {
        <html lang="en">
            <head>
                <title>"Mark"</title>
                <Corten />
            </head>
            <body>
                <main><p>{text}</p></main>
            </body>
        </html>
    };
    Public::new(Duration::from_secs(86_400), req.page(page))
}

/// Waits until the compression thread has run every kept page's brotli 5 job queued before now
/// (the head), or checks that this build makes none for a kept page (the base): see `refused`.
/// Exits the process when the fence does not close.
fn fence(addr: SocketAddr, browser: &str) {
    let started = std::time::Instant::now();
    let coding = |head: &str| {
        head.lines().find_map(|l| l.strip_prefix("content-encoding:")).map(str::trim).unwrap_or("-").to_owned()
    };
    // Kept by the first answer, its job queued by the second (the head).
    for _ in 0..2 {
        get(addr, 0, "/mark", browser);
    }
    let build = env!("CARGO_BIN_NAME");
    let mut asked = 2;
    if build == "head" {
        loop {
            let (head, _) = get(addr, 0, "/mark", browser);
            asked += 1;
            if coding(&head) == "br" {
                break;
            }
            if started.elapsed() > Duration::from_secs(10) {
                eprintln!("FENCE FAILED head: /mark not given br after {asked} answers ({:?})", started.elapsed());
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    } else {
        let (head, _) = get(addr, 0, "/mark", browser);
        asked += 1;
        if coding(&head) != "zstd" || !head.contains("\nage:") {
            eprintln!("FENCE FAILED base: /mark answered {:?} after {asked} answers", coding(&head));
            std::process::exit(1);
        }
    }
    // The job that ran before /mark's (/page's, on the head) ended without a panic: one caught by
    // the compression thread would leave /page as a refusal does.
    let panics = PANICS.load(Ordering::SeqCst);
    if panics != 0 {
        eprintln!("FENCE FAILED {build}: {panics} panics in the process before the fence closed");
        std::process::exit(1);
    }
    eprintln!("FENCE ok {build}: /mark {} after {asked} answers, {} us, no panic", if build == "head" { "br" } else { "zstd" }, started.elapsed().as_micros());
}

/// A TCP listener that accepts nothing until `open` is true.
struct Gated {
    inner: tokio::net::TcpListener,
    open: tokio::sync::watch::Receiver<bool>,
}

impl corten::Listener for Gated {
    type Io = tokio::net::TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let _ = self.open.wait_for(|open| *open).await;
        corten::Listener::accept(&mut self.inner).await
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// One warm-up request to `addr`, with the Host curl and wrk send to the public port: its head
/// (lower case) and the bytes of its body. Exits the process unless it is a 200.
fn get(addr: SocketAddr, port: u16, path: &str, accept: &str) -> (String, usize) {
    let fail = |why: String| -> ! {
        eprintln!("WARM FAILED {path} accept-encoding {accept:?}: {why}");
        std::process::exit(1)
    };
    let mut stream = TcpStream::connect(addr).unwrap_or_else(|e| fail(e.to_string()));
    let encoding = if accept.is_empty() { String::new() } else { format!("accept-encoding: {accept}\r\n") };
    let kind = if path.starts_with("/records") { "accept: application/json\r\n" } else { "" };
    write!(stream, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n{kind}{encoding}connection: close\r\n\r\n")
        .unwrap_or_else(|e| fail(e.to_string()));
    let mut read = Vec::new();
    stream.read_to_end(&mut read).unwrap_or_else(|e| fail(e.to_string()));
    let at = read.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or_else(|| fail("no head".into()));
    let head = String::from_utf8_lossy(&read[..at]).to_ascii_lowercase();
    if !head.starts_with("http/1.1 200 ") {
        fail(head);
    }
    (head, read.len() - at - 4)
}

/// Refuses to start unless the allocator PROBE_ALLOCATOR names is the one in use.
fn check_allocator() -> Result<(), Box<dyn std::error::Error>> {
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap_or_default();
    let found = if maps.contains("libjemalloc") { "jemalloc" } else { "glibc" };
    eprintln!("ALLOCATOR {found}");
    match std::env::var("PROBE_ALLOCATOR") {
        Ok(asked) if asked != found => Err(format!("PROBE_ALLOCATOR={asked}, but the allocator is {found}").into()),
        _ => Ok(()),
    }
}

/// Callgrind's client requests (valgrind/callgrind.h): the magic sequence valgrind.h emits on x86_64,
/// which does nothing when the program does not run under Valgrind.
const CG_ZERO: usize = 0x4354_0001;
const CG_TOGGLE: usize = 0x4354_0002;
const CG_DUMP_AT: usize = 0x4354_0003;

fn callgrind(request: usize, arg: usize) {
    let args: [usize; 6] = [request, arg, 0, 0, 0, 0];
    // SAFETY: the four rotations of rdi total 128 bits (rdi is unchanged) and xchg rbx, rbx changes
    // nothing; under Valgrind, rax points at the request and rdx gets its result.
    unsafe {
        std::arch::asm!(
            "rol rdi, 3", "rol rdi, 13", "rol rdi, 61", "rol rdi, 51", "xchg rbx, rbx",
            inout("rdx") 0usize => _, in("rax") args.as_ptr(), inout("rdi") 0usize => _,
            options(nostack),
        );
    }
}

/// Dumps this thread's and every other thread's counts since the last dump or zero, as `label`.
fn dump(label: &str) {
    let label = std::ffi::CString::new(label).unwrap();
    callgrind(CG_DUMP_AT, label.as_ptr() as usize);
}

/// How long the counting thread sleeps after each URL's two answers, so that the compression thread
/// (the only one then running) makes the job the second queued (the head) before the next URL: the
/// counted answers never share the CPU with it, and the queue never fills.
const PAUSE: Duration = Duration::from_millis(60);

/// The in-process count: `<bin> cg <first|second> <warm|cold> <urls>`, run under
/// `valgrind --tool=callgrind --separate-threads=yes` with jemalloc preloaded as run.sh preloads it.
/// One app with room for every URL (kept_answers(8 GiB), as `twice` serves); <urls> new URLs of
/// /page, each asked twice in a row with a browser's Accept-Encoding, a pause after each. This thread
/// counts only the first or only the second answer of each URL (collection is off at the start and
/// toggled around them); the compression thread, started by the head's first queued job, counts
/// from its start. `warm`: /page?warm asked twice and two seconds left before the count, so the
/// head's thread is started and idle; `cold`: nothing before, so the head's first URL's second
/// answer starts it. Counts are dumped after URL 0 (`url-0`), after URLs 1 to 199 (`urls-1-199`)
/// and after the rest (`urls-200-<n>`): the last over 1,000 URLs is CONTRIBUTING.md's count of 1,200
/// less the count of 200. Every answer's coding and whether it was kept are checked (zstd from
/// both; the first made, the second kept), and after the last dump, not counted, every URL is asked
/// once more: `br_after` is how many were then given brotli 5 (the head: all; the base: none).
fn cg(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let usage = "usage: <bin> cg first|second warm|cold <urls, at least 201>";
    let counted = args.get(2).map(String::as_str).ok_or(usage)?.to_owned();
    let worker = args.get(3).map(String::as_str).ok_or(usage)?.to_owned();
    let urls: usize = args.get(4).ok_or(usage)?.parse()?;
    if !matches!(counted.as_str(), "first" | "second") || !matches!(worker.as_str(), "warm" | "cold") || urls < 201 {
        return Err(usage.into());
    }
    let browser = "gzip, deflate, br, zstd";
    // This thread counts only the answers named; a thread started later counts from its start.
    callgrind(CG_TOGGLE, 0);
    let router = App::new(url::router()).dev(false).kept_answers(8 << 30).router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(async {
        let ask = |path: String| {
            let router = router.clone();
            async move {
                let req = corten::http::Request::get(path)
                    .header("host", "127.0.0.1:18081")
                    .header("accept-encoding", browser)
                    .body(corten::http::Body::empty())
                    .unwrap();
                let res = router.oneshot(req).await.unwrap();
                assert_eq!(res.status().as_u16(), 200);
                let aged = res.headers().contains_key("age");
                let coding = res.headers().get("content-encoding").map_or("-", |c| c.to_str().unwrap()).to_owned();
                (aged, coding, res.into_body().collect().await.unwrap().to_bytes().len())
            }
        };
        if worker == "warm" {
            for _ in 0..2 {
                ask("/page?warm".to_owned()).await;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        let paths: Vec<String> = (0..urls).map(|n| format!("/page?n={n:07}")).collect();
        let mut body = 0;
        callgrind(CG_ZERO, 0);
        for (n, path) in paths.iter().enumerate() {
            for second in [false, true] {
                let path = path.clone();
                let count = second == (counted == "second");
                if count {
                    callgrind(CG_TOGGLE, 0);
                }
                let (aged, coding, bytes) = ask(path).await;
                if count {
                    callgrind(CG_TOGGLE, 0);
                }
                assert!(aged == second && coding == "zstd", "url {n}, answer {}: kept {aged}, {coding}", 1 + usize::from(second));
                body = bytes;
            }
            std::thread::sleep(PAUSE);
            if n == 0 {
                dump("url-0");
            } else if n == 199 {
                dump("urls-1-199");
            }
        }
        dump(&format!("urls-200-{}", urls - 1));
        let mut br = 0;
        for path in &paths {
            br += usize::from(ask(path.clone()).await.1 == "br");
        }
        println!("CG counted={counted} worker={worker} urls={urls} body={body} br_after={br}");
    });
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        PANICS.fetch_add(1, Ordering::SeqCst);
        default(info);
    }));
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("cg") {
        check_allocator()?;
        return cg(&args);
    }
    // What #[tokio::main(flavor = "current_thread")] built.
    tokio::runtime::Builder::new_current_thread().enable_all().build()?.block_on(serve(args))
}

async fn serve(args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let usage = "usage: <port> browser|gzip|refused <bound> <fill>|new|hit|off|private|json-browser|json-new|json-hit|twice";
    let port: u16 = args.get(1).ok_or(usage)?.parse()?;
    // Leaked: the warm-up thread names it too.
    let config: &'static str = Box::leak(args.get(2).ok_or(usage)?.clone().into_boxed_str());
    check_allocator()?;
    let number = |i: usize| -> Result<usize, Box<dyn std::error::Error>> { Ok(args.get(i).ok_or(usage)?.parse()?) };
    let browser = "gzip, deflate, br, zstd";
    let app = App::new(url::router()).dev(false);
    // The fence's app (`refused`), on a port of its own.
    let mut marker = None;
    // (path, Accept-Encoding, times), in order.
    let (app, warm) = match config {
        "browser" => (app, vec![("/page".to_owned(), browser, 4)]),
        "gzip" => (app, vec![("/page".to_owned(), "gzip", 4)]),
        "refused" => {
            let (bound, fill) = (number(3)?, number(4)?);
            let mut warm: Vec<_> = (0..fill).map(|n| (format!("/page?fill={n}"), "identity", 2)).collect();
            warm.push(("/page".to_owned(), browser, 4));
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
            let addr = listener.local_addr()?;
            tokio::spawn(corten::serve_on(vec![listener], App::new(url::router()).dev(false).kept_answers(1 << 20)));
            marker = Some(addr);
            (app.kept_answers(bound), warm)
        }
        "new" => (app.kept_answers(8 << 30), vec![]),
        "hit" => (app, vec![("/page".to_owned(), "", 2)]),
        "off" => (app.kept_answers(0), vec![]),
        "private" => (app, vec![]),
        "json-browser" => (app, vec![("/records".to_owned(), browser, 4)]),
        "json-new" => (app.kept_answers(8 << 30), vec![]),
        "json-hit" => (app, vec![("/records".to_owned(), "", 2)]),
        "twice" => (app.kept_answers(8 << 30), vec![("/page".to_owned(), browser, 4)]),
        other => return Err(format!("unknown config {other}; {usage}").into()),
    };
    let (open, gate) = tokio::sync::watch::channel(warm.is_empty());
    let mut listeners = vec![Gated { inner: tokio::net::TcpListener::bind(("127.0.0.1", port)).await?, open: gate }];
    if !warm.is_empty() {
        let inner = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = inner.local_addr()?;
        listeners.push(Gated { inner, open: tokio::sync::watch::channel(true).1 });
        std::thread::spawn(move || {
            for (path, accept, times) in &warm {
                for _ in 0..*times {
                    get(addr, port, path, accept);
                }
            }
            match marker {
                // Every kept page's brotli 5 job queued so far has run (the head).
                Some(marker) => fence(marker, browser),
                // What is made after an answer (#1846's brotli 5) is made by now.
                None => std::thread::sleep(Duration::from_millis(300)),
            }
            let panics = PANICS.load(Ordering::SeqCst);
            if panics != 0 {
                eprintln!("PANICKED {config}: {panics} panics in the process before its port opened");
                std::process::exit(1);
            }
            let (path, accept, _) = warm.last().expect("a warm-up");
            let (head, body) = get(addr, port, path, accept);
            let line = |name: &str| {
                head.lines().find_map(|l| l.strip_prefix(name).map(str::trim).map(str::to_owned)).unwrap_or("-".into())
            };
            eprintln!(
                "WARM {config}: {path} accept-encoding {accept:?}: content-encoding {}, age {}, {body} bytes",
                line("content-encoding:"),
                line("age:")
            );
            let _ = open.send(true);
        });
    }
    eprintln!("READY {config} on {port}");
    corten::serve_on(listeners, app).await?;
    Ok(())
}