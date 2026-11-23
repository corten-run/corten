// Scratch harness for corten-run/corten#1824 (1824e): what a kept answer leaves allocated. Not part
// of the repository. A global allocator over the system's (jemalloc when it is preloaded, as the
// template's image runs it) counts every live allocation's requested bytes and its usable size
// (`malloc_usable_size`: jemalloc's size class), and, while tracing, where each was made.
//
// Usage: allocmap <page|json> <room|off|hit> [warm] [measured] [traced]
//   room  kept_answers(8 GiB): every request a new URL, kept with room
//   off   kept_answers(0): the same requests, nothing kept (the baseline)
//   hit   the default store, one URL asked for again and again (allocations a hit makes)
// Prints LIVE (requested and usable bytes held per request over `measured` requests after `warm`)
// and, for room, every allocation still held after each of `traced` requests, with its frames.
use corten::prelude::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

extern "C" {
    fn malloc_usable_size(ptr: *mut std::ffi::c_void) -> usize;
}

static LIVE: AtomicUsize = AtomicUsize::new(0);
static USABLE: AtomicUsize = AtomicUsize::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);
static TRACE: AtomicBool = AtomicBool::new(false);
static TRACED_EVER: AtomicBool = AtomicBool::new(false);
static RECORDS: Mutex<Option<HashMap<usize, (usize, usize, std::backtrace::Backtrace)>>> = Mutex::new(None);
thread_local! {
    static INSIDE: Cell<bool> = const { Cell::new(false) };
}

struct Counting;

fn note(at: *mut u8, size: usize, usable: usize) {
    if !TRACE.load(Ordering::Relaxed) || INSIDE.with(Cell::get) {
        return;
    }
    INSIDE.with(|i| i.set(true));
    let trace = std::backtrace::Backtrace::force_capture();
    RECORDS.lock().unwrap().get_or_insert_with(HashMap::new).insert(at as usize, (size, usable, trace));
    INSIDE.with(|i| i.set(false));
}

fn forget(at: *mut u8) {
    if !TRACED_EVER.load(Ordering::Relaxed) || INSIDE.with(Cell::get) {
        return;
    }
    INSIDE.with(|i| i.set(true));
    let gone = RECORDS.lock().unwrap().as_mut().and_then(|map| map.remove(&(at as usize)));
    drop(gone);
    INSIDE.with(|i| i.set(false));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let at = System.alloc(layout);
        if !at.is_null() {
            let usable = malloc_usable_size(at.cast());
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            USABLE.fetch_add(usable, Ordering::Relaxed);
            CALLS.fetch_add(1, Ordering::Relaxed);
            note(at, layout.size(), usable);
        }
        at
    }

    unsafe fn dealloc(&self, at: *mut u8, layout: Layout) {
        let usable = malloc_usable_size(at.cast());
        forget(at);
        System.dealloc(at, layout);
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        USABLE.fetch_sub(usable, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, at: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = malloc_usable_size(at.cast());
        forget(at);
        let new = System.realloc(at, layout, new_size);
        if !new.is_null() {
            let usable = malloc_usable_size(new.cast());
            LIVE.fetch_add(new_size, Ordering::Relaxed);
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            USABLE.fetch_add(usable, Ordering::Relaxed);
            USABLE.fetch_sub(old, Ordering::Relaxed);
            CALLS.fetch_add(1, Ordering::Relaxed);
            note(new, new_size, usable);
        }
        new
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

#[corten::routes]
mod url {
    #[route("/page", get = crate::record)]
    pub struct Record;

    #[route("/records", get = crate::records)]
    pub struct Records;
}

const NAMES: [&str; 24] = [
    "Access", "Area", "Archive", "Boundary", "Condition", "Direction", "Environment", "Feature", "Ground", "Habitat",
    "Information", "Journey", "Key", "Location", "Material", "Notes", "Origin", "Path", "Quality", "Route", "Surface",
    "Terrain", "Use", "View",
];

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

async fn record(req: Req) -> Public<HtmlResult> {
    Public::new(Duration::from_secs(86_400), req.page(document()))
}

/// The record's fields as JSON (1,999 bytes), kept for a day: the 1846r kit's /records.
async fn records() -> Public<JsonResult<Vec<(String, String)>>> {
    let rows: Vec<(String, String)> = NAMES
        .iter()
        .map(|name| (name.to_string(), format!("{name} notes for entry 7: North gate, woodland path and open ground.")))
        .collect();
    let rows: JsonResult<Vec<(String, String)>> = Ok(Json(rows));
    Public::new(Duration::from_secs(86_400), rows)
}

fn snapshot() -> (usize, usize, usize) {
    (LIVE.load(Ordering::Relaxed), USABLE.load(Ordering::Relaxed), CALLS.load(Ordering::Relaxed))
}

/// The frames of `trace` worth reading: from the first that is not the allocator's or std's.
fn frames(trace: &std::backtrace::Backtrace) -> Vec<String> {
    let text = trace.to_string();
    let mut names = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((number, name)) = line.split_once(": ") else { continue };
        if number.parse::<usize>().is_err() {
            continue;
        }
        names.push(name.to_owned());
    }
    let skip = |n: &str| {
        n.starts_with("std::backtrace")
            || n.starts_with("allocmap::note")
            || n.contains("Counting as core::alloc")
            || n.starts_with("__rust")
            || n.starts_with("alloc::alloc::")
            || n.starts_with("alloc::raw_vec")
            || n.starts_with("<alloc::raw_vec")
            || n.starts_with("alloc::vec::")
            || n.starts_with("<alloc::vec")
            || n.starts_with("core::")
            || n.starts_with("std::sys")
            || n.starts_with("<alloc::")
            || n.starts_with("<u8 as")
            || n.starts_with("<[")
            || n.starts_with("<http::header::map::Pos")
            || n.starts_with("<http::header::map::Bucket")
            || n.starts_with("<core::")
            || n.starts_with("alloc::")
    };
    names.into_iter().filter(|n| !skip(n)).take(5).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let what = args.get(1).map(String::as_str).unwrap_or("page");
    let config = args.get(2).map(String::as_str).unwrap_or("room");
    let warm: usize = args.get(3).and_then(|a| a.parse().ok()).unwrap_or(2000);
    let measured: usize = args.get(4).and_then(|a| a.parse().ok()).unwrap_or(8192);
    let traced: usize = args.get(5).and_then(|a| a.parse().ok()).unwrap_or(2);
    let app = App::new(url::router()).dev(false);
    let app = match config {
        "room" => app.kept_answers(8 << 30),
        "off" => app.kept_answers(0),
        _ => app,
    };
    let router = app.router();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let path = if what == "json" { "/records" } else { "/page" };
    runtime.block_on(async {
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let ask = |n: usize| {
            let router = router.clone();
            let url = if config == "hit" { path.to_owned() } else { format!("{path}?s=1700000000&t=1&n={n:07}") };
            async move {
                let mut req = http::Request::get(url).header("host", "127.0.0.1:18081");
                if what == "json" {
                    req = req.header("accept", "application/json");
                }
                let res = router.oneshot(req.body(corten::http::Body::empty()).unwrap()).await.unwrap();
                assert_eq!(res.status().as_u16(), 200);
                let aged = res.headers().contains_key("age");
                let body = res.into_body().collect().await.unwrap().to_bytes().len();
                (aged, body)
            }
        };
        let mut body = 0;
        let mut aged = 0;
        for n in 0..warm {
            let (a, b) = ask(n).await;
            aged += usize::from(a);
            body = b;
        }
        let before = snapshot();
        for n in warm..warm + measured {
            let (a, b) = ask(n).await;
            aged += usize::from(a);
            body = b;
        }
        let after = snapshot();
        println!(
            "LIVE what={what} config={config} body={body} aged={aged} measured={measured} requested_per={:.1} usable_per={:.1} calls_per={:.2}",
            (after.0 as f64 - before.0 as f64) / measured as f64,
            (after.1 as f64 - before.1 as f64) / measured as f64,
            (after.2 - before.2) as f64 / measured as f64,
        );
        for t in 0..traced {
            let n = warm + measured + t;
            TRACED_EVER.store(true, Ordering::Relaxed);
            TRACE.store(true, Ordering::Relaxed);
            let (a, b) = ask(n).await;
            TRACE.store(false, Ordering::Relaxed);
            INSIDE.with(|i| i.set(true));
            let held: Vec<(usize, usize, Vec<String>)> = RECORDS
                .lock()
                .unwrap()
                .take()
                .unwrap_or_default()
                .into_values()
                .map(|(size, usable, trace)| (size, usable, frames(&trace)))
                .collect();
            INSIDE.with(|i| i.set(false));
            let (mut size, mut usable) = (0, 0);
            println!("TRACE request {n} aged={a} body={b}: {} allocations held", held.len());
            let mut held = held;
            held.sort_by(|x, y| y.0.cmp(&x.0));
            for (s, u, f) in &held {
                size += s;
                usable += u;
                println!("  HELD requested={s} usable={u}");
                for frame in f {
                    println!("      {frame}");
                }
            }
            println!("TRACE total requested={size} usable={usable}");
        }
    });
}