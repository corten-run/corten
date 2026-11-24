// Scratch probe for corten-run/corten#1829 (issue #1792: requests that miss a kept page's copy
// together run its handler once): paired cycles and the timing of overlapping misses on a quiet
// host. Not part of the repository. The same program is built against the base and the head trees
// (probe-base, probe-head); only the Cargo package, the bin name and the path to corten differ.
//
// For corten-run/corten#1983 (kit 1983) it has one more route and one more config, and is
// otherwise kit 1965's: /picture.png, a PNG of 8,000 bytes that do not compress, Public for four
// hours (the answer #1964's runs measured, there the catalog benchmark's), and
//   old       the default app, nothing warmed: the driver asks for /picture.png twice, so it is
//             kept, then (for the workload `old`) moves the process's monotonic clock on by
//             10,005 seconds (shim/clockstep.c), so every later request is given a kept answer
//             past the table of ages; /picture-runs is how many times the picture's handler ran
//
// Usage: <bin> <port> <config>
//   full      the default app (32 MiB), filled before its port opens: /page?fill=<n> asked twice
//             each until the second answer is no longer given the kept page (FULL in the log), so
//             a new URL's first request is refused, as the kept_cost fixture's full case
//   made      kept_answers(8 GiB), nothing warmed: every new URL is made and kept with room
//   again     the default app; /again is the page (GET) and a write to it (POST, 204), so a GET
//             after a write makes the page again in the place of the copy the write dropped
//   hit       /page warmed twice with no Accept-Encoding (as wrk asks), so it is kept
//   plain     the default app; /private is the page, not Public (a page for one visitor)
//   wave <slow ms> <reads>  the default app, for the timed waves: /w/page, /w/cookie (sets a
//             cookie, never kept), /w/fail (a 500, never kept), /w/json (1,999 bytes, kept for a
//             data client) and /w/small (a JSON body too small to keep), each Public for one
//             second, each reading a slow source first: <slow ms> of sleep, at most <reads> at a
//             time (0: no limit); /w/runs is how many times their handlers ran
// <bin> wave-client <base port> <head port> <path> <pairs> <status> <accept|-> <label> <gap ms> <csv>
//   Sends <pairs> pairs of waves (one to each build, the order turned every pair) of 64 GETs of
//   <path> at once, on connections opened before the clock starts, each wave once the copy its
//   build kept last has passed its lifetime (<gap ms> after that build's last wave ended). Appends
//   per wave: the handler runs (/w/runs before and after), answers with <status>, answers given
//   kept (an Age), and the times from the wave's start to each answer's last byte, to <csv>.
// While a warm-up runs, the port is bound but not served: a connection waits until the warm-up
// is done (its requests go to a listener of their own on another port). PROBE_ALLOCATOR=jemalloc
// (or glibc) makes the probe refuse to start unless /proc/self/maps shows that allocator. When the
// server stops it logs COUNTS: the /again handler's runs, the writes, and the wave handlers' runs.
use corten::http::{HeaderValue, StatusCode};
use corten::prelude::*;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[corten::routes]
mod url {
    #[route("/page", get = crate::record)]
    pub struct Record;

    #[route("/private", get = crate::private)]
    pub struct Plain;

    #[route("/picture.png", get = crate::picture)]
    pub struct Picture;

    #[route("/picture-runs", get = crate::picture_runs)]
    pub struct PictureRuns;

    #[route("/again", get = crate::again, post = crate::saved)]
    pub struct Again;

    #[route("/w/page", get = crate::wave_page)]
    pub struct WavePage;

    #[route("/w/cookie", get = crate::wave_cookie)]
    pub struct WaveCookie;

    #[route("/w/fail", get = crate::wave_fail)]
    pub struct WaveFail;

    #[route("/w/json", get = crate::wave_json)]
    pub struct WaveJson;

    #[route("/w/small", get = crate::wave_small)]
    pub struct WaveSmall;

    #[route("/w/runs", get = crate::wave_runs)]
    pub struct WaveRuns;
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

/// A record page of about 6 KB: a heading, a description, a definition list and a table (the
/// page the #1846, #1866 and #1865 probes serve).
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
const DAY: Duration = Duration::from_secs(86_400);

async fn record(req: Req) -> Public<HtmlResult> {
    Public::new(DAY, req.page(document()))
}

async fn private(req: Req) -> HtmlResult {
    req.page(document())
}

/// Bytes that do not compress, as a picture's do not (the catalog benchmark's `noise`, as
/// #1964's runs had it).
fn noise(length: usize) -> corten::http::Bytes {
    let mut state = 0x9E37_79B9u32;
    let bytes: Vec<u8> = (0..length)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 24) as u8
        })
        .collect();
    corten::http::Bytes::from(bytes)
}

static PNG: std::sync::LazyLock<corten::http::Bytes> = std::sync::LazyLock::new(|| noise(8000));

/// Kept for four hours, so an answer 10,005 seconds old is still given.
const FOUR_HOURS: Duration = Duration::from_secs(14_400);

/// Runs of the picture's handler: one for a start whose every later request was given the
/// answer its first request kept.
static PICTURES: AtomicUsize = AtomicUsize::new(0);

/// A picture the app holds, of a type no build compresses.
async fn picture() -> Public<corten::Media> {
    PICTURES.fetch_add(1, Ordering::Relaxed);
    Public::new(FOUR_HOURS, corten::Media::new("image/png", PNG.clone()))
}

async fn picture_runs() -> corten::Media {
    corten::Media::new("text/plain", PICTURES.load(Ordering::Relaxed).to_string())
}

/// Runs of the /again page's handler, and writes to it.
static AGAIN_RUNS: AtomicUsize = AtomicUsize::new(0);
static WRITES: AtomicUsize = AtomicUsize::new(0);

async fn again(req: Req) -> Public<HtmlResult> {
    AGAIN_RUNS.fetch_add(1, Ordering::Relaxed);
    Public::new(DAY, req.page(document()))
}

async fn saved() -> StatusCode {
    WRITES.fetch_add(1, Ordering::Relaxed);
    StatusCode::NO_CONTENT
}

/// A wave route's lifetime: its copy has passed it a second after it was made.
const LIFETIME: Duration = Duration::from_secs(1);

/// Runs of the wave routes' handlers.
static RUNS: AtomicUsize = AtomicUsize::new(0);

/// The slow source a wave route reads: how long a read takes, and how many may run at once.
static SOURCE: OnceLock<(Duration, Option<tokio::sync::Semaphore>)> = OnceLock::new();

/// A read from the slow source, counted as one run of a wave route's handler.
async fn read() {
    RUNS.fetch_add(1, Ordering::Relaxed);
    let (slow, reads) = SOURCE.get().expect("the wave config sets the source");
    let _read = match reads {
        Some(reads) => Some(reads.acquire().await.expect("the source is never closed")),
        None => None,
    };
    tokio::time::sleep(*slow).await;
}

async fn wave_page(req: Req) -> Public<HtmlResult> {
    read().await;
    Public::new(LIFETIME, req.page(document()))
}

/// The page with a cookie: never kept (kept_wave.rs's never).
async fn wave_cookie(req: Req) -> Public<HtmlResult> {
    read().await;
    let page = req.page(document()).map(|mut page| {
        page.headers_mut().append("set-cookie", HeaderValue::from_static("seen=1"));
        page
    });
    Public::new(LIFETIME, page)
}

/// A handler whose source failed: a 500, never kept.
async fn wave_fail() -> Public<HtmlResult> {
    read().await;
    let failed: corten::Result<corten::answer::HtmlResponse<corten::answer::ForAll>> = Err(corten::Error::new("the slow source failed"));
    Public::new(LIFETIME, failed)
}

/// The record's fields as JSON (1,999 bytes): #1846's kept_coding_cost.rs body, kept for a data
/// client (1,024 bytes or more, in a build that compresses).
fn rows() -> Vec<(String, String)> {
    NAMES.iter().map(|name| (name.to_string(), format!("{name} notes for entry 7: North gate, woodland path and open ground."))).collect()
}

async fn wave_json() -> Public<JsonResult<Vec<(String, String)>>> {
    read().await;
    let rows: JsonResult<Vec<(String, String)>> = Ok(Json(rows()));
    Public::new(LIFETIME, rows)
}

/// A JSON body too small to keep (under 1,024 bytes).
async fn wave_small() -> Public<JsonResult<Vec<(String, String)>>> {
    read().await;
    let rows: JsonResult<Vec<(String, String)>> = Ok(Json(rows().into_iter().take(2).collect()));
    Public::new(LIFETIME, rows)
}

async fn wave_runs() -> corten::Media {
    corten::Media::new("text/plain", RUNS.load(Ordering::Relaxed).to_string())
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
    write!(stream, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n{encoding}connection: close\r\n\r\n")
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

/// The value of the header `name` (lower case, with its colon) in `head`, or "-".
fn line(head: &str, name: &str) -> String {
    head.lines().find_map(|l| l.strip_prefix(name).map(str::trim).map(str::to_owned)).unwrap_or("-".into())
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

/// What a server warms before its port opens.
enum Warm {
    None,
    /// The path, asked twice with no Accept-Encoding, then once more for the WARM line.
    Twice(&'static str),
    /// Fill the store (the full config).
    Fill,
}

/// Fills the store behind `addr`: each new URL asked twice, until the second is no longer given
/// the page the first kept. Returns how many URLs were kept first.
fn fill(addr: SocketAddr, port: u16) -> usize {
    for n in 0..200_000 {
        let at = format!("/page?fill={n}");
        get(addr, port, &at, "");
        let (head, _) = get(addr, port, &at, "");
        if line(&head, "age:") == "-" {
            return n;
        }
    }
    eprintln!("WARM FAILED: the store never filled");
    std::process::exit(1)
}

async fn serve(app: App, port: u16, config: &'static str, warm: Warm) -> Result<(), Box<dyn std::error::Error>> {
    let gated = !matches!(warm, Warm::None);
    let (open, gate) = tokio::sync::watch::channel(!gated);
    let mut listeners = vec![Gated { inner: tokio::net::TcpListener::bind(("127.0.0.1", port)).await?, open: gate }];
    if gated {
        let inner = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = inner.local_addr()?;
        listeners.push(Gated { inner, open: tokio::sync::watch::channel(true).1 });
        std::thread::spawn(move || {
            match warm {
                Warm::None => {}
                Warm::Twice(path) => {
                    get(addr, port, path, "");
                    get(addr, port, path, "");
                    std::thread::sleep(Duration::from_millis(300));
                    let (head, body) = get(addr, port, path, "");
                    eprintln!(
                        "WARM {config}: {path} accept-encoding \"\": content-encoding {}, age {}, {body} bytes",
                        line(&head, "content-encoding:"),
                        line(&head, "age:")
                    );
                }
                Warm::Fill => {
                    let started = Instant::now();
                    let kept = fill(addr, port);
                    eprintln!(
                        "FULL {config}: {kept} pages kept, then /page?fill={kept}'s second answer was not given the kept page ({:.1} s)",
                        started.elapsed().as_secs_f64()
                    );
                }
            }
            let _ = open.send(true);
        });
    }
    eprintln!("READY {config} on {port}");
    corten::serve_on(listeners, app).await?;
    eprintln!(
        "COUNTS {config}: /again handler runs {}, writes {}, wave handler runs {}",
        AGAIN_RUNS.load(Ordering::Relaxed),
        WRITES.load(Ordering::Relaxed),
        RUNS.load(Ordering::Relaxed)
    );
    Ok(())
}

/// One answer to a wave: its status, whether it was given kept (an Age), and the milliseconds
/// from the wave's start to its last byte.
type Answer = (u16, bool, f64);

/// The status and head of a whole answer read to its end.
fn parse(read: &[u8]) -> Result<(u16, String), String> {
    let at = read.windows(4).position(|w| w == b"\r\n\r\n").ok_or("no head")?;
    let head = String::from_utf8_lossy(&read[..at]).to_ascii_lowercase();
    let status = head.get(9..12).and_then(|s| s.parse().ok()).ok_or_else(|| format!("no status in {head:?}"))?;
    Ok((status, head))
}

/// The wave routes' handler runs so far, from /w/runs.
async fn runs(port: u16) -> Result<usize, Box<dyn std::error::Error>> {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(format!("GET /w/runs HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n").as_bytes()).await?;
    let mut read = Vec::new();
    stream.read_to_end(&mut read).await?;
    let (status, _) = parse(&read)?;
    let at = read.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(0);
    let body = String::from_utf8_lossy(&read[at + 4..]).trim().to_string();
    if status != 200 {
        return Err(format!("/w/runs answered {status}").into());
    }
    Ok(body.parse()?)
}

/// 64 GETs of `path` at once, on connections opened first.
async fn wave(port: u16, path: &str, accept: &str) -> Result<Vec<Answer>, Box<dyn std::error::Error>> {
    let mut streams = Vec::with_capacity(64);
    for _ in 0..64 {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        stream.set_nodelay(true)?;
        streams.push(stream);
    }
    // The server accepts them meanwhile, so the clock starts with every connection open.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let accept = if accept == "-" { String::new() } else { format!("accept: {accept}\r\n") };
    let request = std::sync::Arc::new(format!("GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n{accept}connection: close\r\n\r\n"));
    let start = Instant::now();
    let sent: Vec<_> = streams
        .into_iter()
        .map(|mut stream| {
            let request = request.clone();
            tokio::spawn(async move {
                stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
                let mut read = Vec::new();
                stream.read_to_end(&mut read).await.map_err(|e| e.to_string())?;
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                let (status, head) = parse(&read)?;
                let kept = head.lines().any(|l| l.starts_with("age:"));
                Ok::<Answer, String>((status, kept, ms))
            })
        })
        .collect();
    let mut answers = Vec::with_capacity(64);
    for answer in sent {
        answers.push(answer.await??);
    }
    Ok(answers)
}

/// The `at` share of `sorted` (kept_wave.rs's).
fn share(sorted: &[f64], at: f64) -> f64 {
    sorted.get(((sorted.len() as f64 - 1.0) * at).round() as usize).copied().unwrap_or(f64::NAN)
}

async fn wave_client(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let usage = "usage: wave-client <base port> <head port> <path> <pairs> <status> <accept|-> <label> <gap ms> <csv>";
    if args.len() != 11 {
        return Err(usage.into());
    }
    let ports: [u16; 2] = [args[2].parse()?, args[3].parse()?];
    let (path, pairs, status, accept, label) = (&args[4], args[5].parse::<usize>()?, args[6].parse::<u16>()?, &args[7], &args[8]);
    let gap = Duration::from_millis(args[9].parse()?);
    let mut csv = std::fs::OpenOptions::new().create(true).append(true).open(&args[10])?;
    let names = ["base", "head"];
    let mut ended: [Option<Instant>; 2] = [None, None];
    let mut waves = [0usize; 2];
    for pair in 1..=pairs {
        let order = if pair % 2 == 1 { [0, 1] } else { [1, 0] };
        for b in order {
            if let Some(ended) = ended[b] {
                tokio::time::sleep_until((ended + gap).into()).await;
            }
            waves[b] += 1;
            let before = runs(ports[b]).await?;
            let answers = wave(ports[b], path, accept).await?;
            ended[b] = Some(Instant::now());
            let after = runs(ports[b]).await?;
            let ok = answers.iter().filter(|(s, ..)| *s == status).count();
            let kept = answers.iter().filter(|(s, kept, _)| *s == status && *kept).count();
            let mut times: Vec<f64> = answers.iter().map(|(.., ms)| *ms).collect();
            times.sort_by(f64::total_cmp);
            let row = format!(
                "{label},{pair},{},{},{},{},{},{},{:.2},{:.2},{:.2},{:.2},{:.2}",
                names[b],
                waves[b],
                after - before,
                answers.len(),
                ok,
                kept,
                times[0],
                share(&times, 0.5),
                share(&times, 0.9),
                share(&times, 0.99),
                times[times.len() - 1]
            );
            writeln!(csv, "{row}")?;
            if ok != answers.len() {
                let other: Vec<u16> = answers.iter().map(|(s, ..)| *s).filter(|s| *s != status).collect();
                return Err(format!("{label} pair {pair} {}: {} answers not {status}: {other:?}", names[b], other.len()).into());
            }
        }
        if pair % 10 == 0 {
            println!("{label}: pair {pair} of {pairs} done");
        }
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("wave-client") {
        return wave_client(&args).await;
    }
    let usage = "usage: <port> full|made|again|hit|plain|old|wave <slow ms> <reads> (or wave-client ...)";
    let port: u16 = args.get(1).ok_or(usage)?.parse()?;
    // Leaked: the warm-up thread names it too.
    let config: &'static str = Box::leak(args.get(2).ok_or(usage)?.clone().into_boxed_str());
    check_allocator()?;
    let app = App::new(url::router()).dev(false);
    match config {
        "full" => serve(app, port, config, Warm::Fill).await,
        "made" => serve(app.kept_answers(8 << 30), port, config, Warm::None).await,
        "again" | "plain" | "old" => serve(app, port, config, Warm::None).await,
        "hit" => serve(app, port, config, Warm::Twice("/page")).await,
        "wave" => {
            let slow: u64 = args.get(3).ok_or(usage)?.parse()?;
            let reads: usize = args.get(4).ok_or(usage)?.parse()?;
            let reads = (reads > 0).then(|| tokio::sync::Semaphore::new(reads));
            let _ = SOURCE.set((Duration::from_millis(slow), reads));
            serve(app, port, config, Warm::None).await
        }
        other => Err(format!("unknown config {other}; {usage}").into()),
    }
}
