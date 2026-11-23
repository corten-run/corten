// Scratch probe for corten-run/corten#1865 (issue #1825: a `Public` answer's Cache-Control made
// once per set of numbers on a thread, and not read again while it stands as `Cache` wrote it):
// paired cycles on a quiet host. Not part of the repository. The same program is built against the
// base and the head trees (probe-base, probe-head); only the Cargo package, the bin name and the
// path to corten differ.
//
// Usage: <bin> <port> <config>
//   private   /private, the record page for one visitor (not Public), in the default app
//   off       /page, the record page Public for a day, in an app with kept_answers(0)
//   hit       /page in the default app, warmed twice with no Accept-Encoding (as wrk asks), so it
//             is kept and every request is given the kept page
//   staged    /r/{n}: the record page Public with one of five policies, in an app with
//             kept_answers(0) and one middleware of its own (RequestId, which adds a header and
//             leaves Cache-Control alone)
//   unstaged  /u/{n}: a short text answer Public with one of five policies, on a route that says
//             `unstaged` (no stage, no middleware, no cache::settle), in an app with kept_answers(0)
//   fallback  /page in the default app, kept as `hit` keeps it, and then /r/0 to /r/3 asked once
//             each (kept too), so the server's one thread has made four other headers since the
//             page's: the head's thread no longer holds the kept page's header, and every request's
//             cache::settle reads that header line by line as main does (the head's fallback, its
//             look through the held headers first). Before the port opens the probe checks the
//             four answers' headers (EVICT in its log) and logs the kept page's WARM line after them.
//   nostore   /n: a short text answer (FIGURE) in NoStore, on a staged route, in the staged app
//             (kept_answers(0), RequestId), after /r/0 to /r/3 were asked once each before the port
//             opened (EVICT in its log), so the head's thread holds four headers, as many as it
//             holds: each answer's `no-store` is a constant, and the head's settle looks through
//             the four before it reads the line as main does. The probe checks /n's Cache-Control
//             is `no-store` after those four (CONSTANT in its log).
//   immutable /i: the same with a short SVG, Public::immutable (`public, max-age=31536000,
//             immutable`), the head's other constant.
// /r/{n} and /u/{n} with n from 0 to 4 answer policy n: max-age=2592000+n, s-maxage=2592000,
// stale-while-revalidate=1036800, stale-if-error=604800, a 96-byte header (the PR's `rotating`
// case). A larger n (the load asks /r/5 and /u/5) answers the next policy in turn by a counter of
// the process, 0, 1, 2, 3, 4, 0, ..., so the server's one thread asks for the five in that order
// whatever order the load's connections arrive in: the head's thread holds four, so every answer
// makes its header again (its miss path). A counter in the load script could not promise that:
// two wrk threads' sequences interleave at the server, and a policy asked twice running, or among
// the last four made, would be held. Before the port opens, a staged or unstaged probe asks .../5
// ten times on a listener of its own and checks the ten headers are the five policies in turn
// (ROTATION in its log), or exits. The load asks /u/0 for the unstaged route with one policy
// (run.sh's unstaged-one): the same header for every answer, which the head held on a thread
// before it made an unstaged answer's header as main does.
// While a warm-up or that check runs, the port is bound but not served: a connection waits until
// it is done. PROBE_ALLOCATOR=jemalloc (or glibc) makes the probe refuse to start unless
// /proc/self/maps shows that allocator.
use corten::http::{HeaderValue, Request, Response};
use corten::prelude::*;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

#[corten::routes]
mod url {
    #[route("/page", get = crate::record)]
    pub struct Record;

    #[route("/private", get = crate::private)]
    pub struct Plain;

    #[route("/r/{n}", get = crate::rotate)]
    pub struct Rotate {
        pub n: u32,
    }

    #[route("/u/{n}", get = crate::rotate_unstaged, unstaged)]
    pub struct Data {
        pub n: u32,
    }

    #[route("/n", get = crate::no_store)]
    pub struct Short;

    #[route("/i", get = crate::asset)]
    pub struct Asset;
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

/// The first policy's max-age and every policy's s-maxage, 30 days.
const MONTH: u64 = 2_592_000;

/// The unstaged route's answer: a figure every client polls.
const FIGURE: &str = "{\"route\":\"ridge-trail-7\",\"open\":true,\"walkers\":42,\"updated\":\"2026-11-21T18:00:00Z\"}\n";

/// The process's count of answers given the next policy in turn.
static TURN: AtomicU64 = AtomicU64::new(0);

/// The policy for `n`: `n` itself from 0 to 4, else the next in turn.
fn policy(n: u32) -> u64 {
    if n < 5 {
        u64::from(n)
    } else {
        TURN.fetch_add(1, Ordering::Relaxed) % 5
    }
}

/// `answer` with what every policy has beside its max-age.
fn with_policy<A: corten::answer::Shareable>(answer: Public<A>) -> Public<A> {
    answer
        .shared(Duration::from_secs(MONTH))
        .stale_while_revalidate(Duration::from_secs(1_036_800))
        .stale_if_error(Duration::from_secs(604_800))
}

/// The Cache-Control policy `k` is sent with.
fn expected(k: u64) -> String {
    format!(
        "public, max-age={}, s-maxage={MONTH}, stale-while-revalidate=1036800, stale-if-error=604800",
        MONTH + k
    )
}

async fn rotate(req: Req, at: corten::Params<url::Rotate>) -> Public<HtmlResult> {
    let k = policy(at.n);
    with_policy(Public::new(Duration::from_secs(MONTH + k), req.page(document())))
}

async fn rotate_unstaged(at: corten::Params<url::Data>) -> Public<&'static str> {
    let k = policy(at.n);
    with_policy(Public::new(Duration::from_secs(MONTH + k), FIGURE))
}

/// `nostore`'s answer: the figure, which nothing may keep.
async fn no_store() -> NoStore<&'static str> {
    NoStore(FIGURE)
}

/// `immutable`'s answer: a short image at a URL taken to name its content.
const SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"><circle cx=\"4\" cy=\"4\" r=\"3\"/></svg>\n";

async fn asset() -> Public<corten::Media> {
    Public::immutable(corten::Media::new("image/svg+xml", SVG.as_bytes()))
}

/// A middleware of the app's own: adds a header after the handler and leaves Cache-Control alone.
struct RequestId;

impl corten::Middleware for RequestId {
    async fn call(&self, req: Request, next: impl corten::Next) -> Response {
        let mut res = next.run(req).await;
        res.headers_mut().insert("x-request-id", HeaderValue::from_static("r-1"));
        res
    }
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

/// One request to `addr`, with the Host curl and wrk send to the public port: its head (lower
/// case) and the bytes of its body. Exits the process unless it is a 200.
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

/// The policies `fallback` asks for after its page is kept: four, as many as the head's thread holds.
const EVICT: [u32; 4] = [0, 1, 2, 3];

/// Serves `app` on `port` once its warm-up (path, Accept-Encoding, times), then the rotating route's
/// policies in `evict` asked once each, the constant's check (a path and the Cache-Control it must
/// answer) and its rotation check (the prefix of the rotating route) are done.
async fn serve<M: corten::Middleware>(
    app: corten::App<M>,
    port: u16,
    config: &'static str,
    warm: Vec<(String, &'static str, usize)>,
    evict: &'static [u32],
    constant: Option<(&'static str, &'static str)>,
    rotation: Option<&'static str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let gated = !warm.is_empty() || !evict.is_empty() || constant.is_some() || rotation.is_some();
    let (open, gate) = tokio::sync::watch::channel(!gated);
    let mut listeners = vec![Gated { inner: tokio::net::TcpListener::bind(("127.0.0.1", port)).await?, open: gate }];
    if gated {
        let inner = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = inner.local_addr()?;
        listeners.push(Gated { inner, open: tokio::sync::watch::channel(true).1 });
        std::thread::spawn(move || {
            for (path, accept, times) in &warm {
                for _ in 0..*times {
                    get(addr, port, path, accept);
                }
            }
            if !evict.is_empty() {
                for &k in evict {
                    let path = format!("/r/{k}");
                    let (head, _) = get(addr, port, &path, "");
                    let (sent, want) = (line(&head, "cache-control:"), expected(u64::from(k)));
                    if sent != want {
                        eprintln!("EVICT FAILED {path}: cache-control {sent:?}, not {want:?}");
                        std::process::exit(1);
                    }
                }
                eprintln!("EVICT ok {config}: /r/0 to /r/{} answered their own policies, in that order", evict.len() - 1);
            }
            if let Some((path, want)) = constant {
                let (head, body) = get(addr, port, path, "");
                let sent = line(&head, "cache-control:");
                if sent != want {
                    eprintln!("CONSTANT FAILED {path}: cache-control {sent:?}, not {want:?}");
                    std::process::exit(1);
                }
                eprintln!("CONSTANT ok {config}: {path} answered cache-control {sent:?}, {body} bytes, after the four");
            }
            if let Some((path, accept, _)) = warm.last() {
                std::thread::sleep(Duration::from_millis(300));
                let (head, body) = get(addr, port, path, accept);
                eprintln!(
                    "WARM {config}: {path} accept-encoding {accept:?}: content-encoding {}, age {}, {body} bytes",
                    line(&head, "content-encoding:"),
                    line(&head, "age:")
                );
            }
            if let Some(prefix) = rotation {
                let path = format!("{prefix}5");
                for i in 0..10 {
                    let (head, _) = get(addr, port, &path, "");
                    let (sent, want) = (line(&head, "cache-control:"), expected(i % 5));
                    if sent != want {
                        eprintln!("ROTATION FAILED {path}: answer {i} has cache-control {sent:?}, not {want:?}");
                        std::process::exit(1);
                    }
                }
                eprintln!(
                    "ROTATION ok {config}: {path} answered the five policies in turn twice, max-age {} to {}, {} bytes each",
                    MONTH,
                    MONTH + 4,
                    expected(0).len()
                );
            }
            let _ = open.send(true);
        });
    }
    eprintln!("READY {config} on {port}");
    corten::serve_on(listeners, app).await?;
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: <port> private|off|hit|staged|unstaged|fallback|nostore|immutable";
    let port: u16 = args.get(1).ok_or(usage)?.parse()?;
    // Leaked: the warm-up thread names it too.
    let config: &'static str = Box::leak(args.get(2).ok_or(usage)?.clone().into_boxed_str());
    check_allocator()?;
    let app = App::new(url::router()).dev(false);
    let immutable = Some(("/i", "public, max-age=31536000, immutable"));
    match config {
        "private" => serve(app, port, config, vec![], &[], None, None).await,
        "off" => serve(app.kept_answers(0), port, config, vec![], &[], None, None).await,
        "hit" => serve(app, port, config, vec![("/page".to_owned(), "", 2)], &[], None, None).await,
        "staged" => serve(app.kept_answers(0).middleware(RequestId), port, config, vec![], &[], None, Some("/r/")).await,
        "unstaged" => serve(app.kept_answers(0), port, config, vec![], &[], None, Some("/u/")).await,
        "fallback" => serve(app, port, config, vec![("/page".to_owned(), "", 2)], &EVICT, None, None).await,
        "nostore" => {
            serve(app.kept_answers(0).middleware(RequestId), port, config, vec![], &EVICT, Some(("/n", "no-store")), None).await
        }
        "immutable" => serve(app.kept_answers(0).middleware(RequestId), port, config, vec![], &EVICT, immutable, None).await,
        other => Err(format!("unknown config {other}; {usage}").into()),
    }
}