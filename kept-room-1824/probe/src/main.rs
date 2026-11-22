// Scratch probe for corten-run/corten#1824 (what a page kept in a store with room costs the
// kernel, and what reusing memory already touched would save): paired cycles, page faults and
// resident memory on a quiet host, and instructions and faults in process here. Not part of the
// repository. One program, built against ../work: main's tree, or main with a variant's diff
// (build.sh). The page is the 1846r kit's record page (about 6 KB), so its figures sit beside
// that kit's and #1866's.
//
// Usage: probe <port> <config>          serve on 127.0.0.1:<port> (corten::serve_on)
//        probe cg <config> <requests>   in process, as tests/router_cost.rs drives the router
// Configs:
//   room   kept_answers(8 GiB), nothing warmed: every new URL of /page is kept with room
//   off    kept_answers(0): /page is Public and nothing is kept
//   hit    the default app, /page warmed twice with no Accept-Encoding (as wrk asks): kept
//   plain  the default app; /private is the same page, not Public
// While a warm-up runs (hit), the port is bound but not served: a connection waits until it is
// done (its requests go to a listener of their own). PROBE_ALLOCATOR=jemalloc (or glibc) makes
// the probe refuse to start unless /proc/self/maps shows that allocator.
//
// The cg mode sends <requests> requests through the router with oneshot, one at a time, each with
// the Host wrk sends: room and off a new URL each (the length new-url.lua's are), hit /page and
// plain /private. It prints the process's minor faults and resident memory before and after
// them (CG ...), for a count of the faults a kept answer takes without perf.
use corten::prelude::*;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[corten::routes]
mod url {
    #[route("/page", get = crate::record)]
    pub struct Record;

    #[route("/private", get = crate::private)]
    pub struct Plain;
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
fn get(addr: SocketAddr, port: u16, path: &str) -> (String, usize) {
    let fail = |why: String| -> ! {
        eprintln!("WARM FAILED {path}: {why}");
        std::process::exit(1)
    };
    let mut stream = TcpStream::connect(addr).unwrap_or_else(|e| fail(e.to_string()));
    write!(stream, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n").unwrap_or_else(|e| fail(e.to_string()));
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

/// The app for `config`, and the path warmed before the port is served (hit).
fn app(config: &str) -> Result<(App, Option<&'static str>), String> {
    let app = App::new(url::router()).dev(false);
    Ok(match config {
        "room" => (app.kept_answers(8 << 30), None),
        "off" => (app.kept_answers(0), None),
        "hit" => (app, Some("/page")),
        "plain" => (app, None),
        other => return Err(format!("unknown config {other}: room|off|hit|plain")),
    })
}

/// This process's minor faults so far and its resident memory in KiB.
fn faults_and_rss() -> (u64, u64) {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    // The command name, in parentheses, may hold spaces; the fields after it are fixed.
    let fields: Vec<&str> = stat.rsplit_once(')').map_or("", |(_, rest)| rest).split_whitespace().collect();
    let minflt = fields.get(7).and_then(|f| f.parse().ok()).unwrap_or(0);
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let rss = status.lines().find_map(|l| l.strip_prefix("VmRSS:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok()).unwrap_or(0);
    (minflt, rss)
}

/// The in-process run (`probe cg <config> <requests>`).
fn cg(config: &str, requests: usize) -> Result<(), Box<dyn std::error::Error>> {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let (app, warm) = app(config)?;
    let router = app.router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(async {
        let ask = |path: String| {
            let router = router.clone();
            async move {
                let req = http::Request::get(path).header("host", "127.0.0.1:18081").body(corten::http::Body::empty()).unwrap();
                let res = router.oneshot(req).await.unwrap();
                assert_eq!(res.status().as_u16(), 200);
                let aged = res.headers().contains_key("age");
                let bytes = res.into_body().collect().await.unwrap().to_bytes().len();
                (aged, bytes)
            }
        };
        if let Some(path) = warm {
            ask(path.to_owned()).await;
            assert!(ask(path.to_owned()).await.0, "the warmed page is kept");
        }
        let (faults, rss) = faults_and_rss();
        let mut aged = 0;
        let mut bytes = 0;
        for n in 0..requests {
            let path = match config {
                "room" | "off" => format!("/page?s=1700000000&t=1&n={n:07}"),
                "hit" => "/page".to_owned(),
                _ => "/private".to_owned(),
            };
            let (a, b) = ask(path).await;
            aged += usize::from(a);
            bytes = b;
        }
        let (faults_after, rss_after) = faults_and_rss();
        println!(
            "CG config={config} requests={requests} aged={aged} body={bytes} minflt={} rss_kb_before={rss} rss_kb_after={rss_after} minflt_per_request={:.3} rss_bytes_per_request={:.0}",
            faults_after - faults,
            (faults_after - faults) as f64 / requests.max(1) as f64,
            (rss_after.saturating_sub(rss) * 1024) as f64 / requests.max(1) as f64
        );
    });
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: probe <port> room|off|hit|plain | probe cg room|off|hit|plain <requests>";
    check_allocator()?;
    if args.get(1).map(String::as_str) == Some("cg") {
        let config = args.get(2).ok_or(usage)?;
        let requests: usize = args.get(3).ok_or(usage)?.parse()?;
        return cg(config, requests);
    }
    let port: u16 = args.get(1).ok_or(usage)?.parse()?;
    let config: &'static str = Box::leak(args.get(2).ok_or(usage)?.clone().into_boxed_str());
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime.block_on(serve(port, config))
}

async fn serve(port: u16, config: &'static str) -> Result<(), Box<dyn std::error::Error>> {
    let (app, warm) = app(config)?;
    let (open, gate) = tokio::sync::watch::channel(warm.is_none());
    let mut listeners = vec![Gated { inner: tokio::net::TcpListener::bind(("127.0.0.1", port)).await?, open: gate }];
    if let Some(path) = warm {
        let inner = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = inner.local_addr()?;
        listeners.push(Gated { inner, open: tokio::sync::watch::channel(true).1 });
        std::thread::spawn(move || {
            get(addr, port, path);
            get(addr, port, path);
            let (head, body) = get(addr, port, path);
            let age = head.lines().find_map(|l| l.strip_prefix("age:")).map_or("-".to_owned(), |a| a.trim().to_owned());
            eprintln!("WARM {config}: {path}: age {age}, {body} bytes");
            let _ = open.send(true);
        });
    }
    eprintln!("READY {config} on {port}");
    corten::serve_on(listeners, app).await?;
    Ok(())
}