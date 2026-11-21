//! Requests that miss a kept page together, timed (`docs/design.md#choice-kept-pages`): a wave
//! of `WAVE_REQUESTS` (64) requests sent at once for a page whose handler reads a slow source,
//! one that answers `WAVE_SOURCE` (4) reads at a time in `WAVE_SLOW` (50) milliseconds each,
//! under a deadline of `WAVE_DEADLINE` (500) milliseconds. With `WAVE_CASE=stale` the page was
//! kept and a write dropped it; with `cold` nothing was kept yet, as after a start; with `never`
//! the page sets a cookie, so it is never kept, and two waves are sent one after the other. Each of
//! `WAVE_ROUNDS` (10) rounds, on an app of its own, prints the handler's runs, the answers
//! given, kept and failed, and their times. `cargo test --release -p corten-run --test kept_wave
//! -- --ignored --nocapture refresh_wave`. `--ignored --exact serve` serves the page on
//! `HOST`:`PORT` until stopped, for a load generator: once it is kept, every request is given it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use corten::{
    http::{Body, Request, StatusCode},
    prelude::*,
    App, Public,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[corten::routes]
mod url {
    #[route("/wave", get = crate::page, post = crate::saved)]
    pub struct Wave;

    #[route("/never", get = crate::never)]
    pub struct Never;
}

fn setting(name: &str, unset: u64) -> u64 {
    std::env::var(name).map_or(unset, |value| value.parse().unwrap())
}

static RUNS: AtomicUsize = AtomicUsize::new(0);
static SOURCE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

/// A read from the slow source.
async fn read() {
    RUNS.fetch_add(1, Ordering::Relaxed);
    let source = SOURCE.get_or_init(|| tokio::sync::Semaphore::new(setting("WAVE_SOURCE", 4) as usize));
    let _read = source.acquire().await.unwrap();
    tokio::time::sleep(Duration::from_millis(setting("WAVE_SLOW", 50))).await;
}

fn document() -> impl corten::Document {
    html! {
        <html lang="en">
            <head>
                <title>"Wave"</title>
                <Corten />
            </head>
            <body>
                <main><p>"A page read from a slow source"</p></main>
            </body>
        </html>
    }
}

async fn page(req: Req) -> Public<HtmlResult> {
    read().await;
    Public::new(Duration::from_secs(600), req.page(document()))
}

async fn never(req: Req) -> Public<HtmlResult> {
    read().await;
    let page = req.page(document()).map(|mut page| {
        page.headers_mut().append("set-cookie", corten::http::HeaderValue::from_static("seen=1"));
        page
    });
    Public::new(Duration::from_secs(600), page)
}

async fn saved() -> StatusCode {
    StatusCode::NO_CONTENT
}

fn request(method: &str, path: &str) -> Request {
    let req = Request::builder().method(method).uri(path).header("host", "localhost");
    let req = match method {
        "GET" => req.header("accept", "text/html,application/xhtml+xml,*/*;q=0.8"),
        _ => req.header("sec-fetch-site", "same-origin"),
    };
    req.body(Body::empty()).unwrap()
}

/// The `at` share of `sorted`, in milliseconds.
fn share(sorted: &[f64], at: f64) -> f64 {
    sorted.get(((sorted.len() as f64 - 1.0) * at).round() as usize).copied().unwrap_or(f64::NAN)
}

#[test]
#[ignore = "a timed measurement"]
fn refresh_wave() {
    let case = std::env::var("WAVE_CASE").unwrap_or_else(|_| "stale".into());
    let (requests, rounds) = (setting("WAVE_REQUESTS", 64) as usize, setting("WAVE_ROUNDS", 10));
    let deadline = Duration::from_millis(setting("WAVE_DEADLINE", 500));
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
    runtime.block_on(async {
        for round in 1..=rounds {
            let router = App::new(url::router()).dev(false).deadline(deadline).router();
            if case == "stale" {
                for (method, status) in [("GET", StatusCode::OK), ("GET", StatusCode::OK), ("POST", StatusCode::NO_CONTENT)] {
                    assert_eq!(router.clone().oneshot(request(method, "/wave")).await.unwrap().status(), status);
                }
            }
            let (path, waves) = if case == "never" { ("/never", 2) } else { ("/wave", 1) };
            for wave in 1..=waves {
                let before = RUNS.load(Ordering::Relaxed);
                let start = Instant::now();
                let sent: Vec<_> = (0..requests)
                    .map(|_| {
                        let router = router.clone();
                        tokio::spawn(async move {
                            let res = router.oneshot(request("GET", path)).await.unwrap();
                            let (status, kept) = (res.status(), res.headers().contains_key("age"));
                            res.into_body().collect().await.unwrap();
                            (status, kept, start.elapsed().as_secs_f64() * 1000.0)
                        })
                    })
                    .collect();
                let mut answers = Vec::new();
                for request in sent {
                    answers.push(request.await.unwrap());
                }
                let runs = RUNS.load(Ordering::Relaxed) - before;
                let ok = answers.iter().filter(|(status, ..)| *status == StatusCode::OK).count();
                let kept = answers.iter().filter(|(status, kept, _)| *status == StatusCode::OK && *kept).count();
                let failed = answers.iter().filter(|(status, ..)| *status == StatusCode::SERVICE_UNAVAILABLE).count();
                assert_eq!(ok + failed, requests, "only answers and deadlines");
                let mut times: Vec<f64> =
                    answers.iter().filter(|(status, ..)| *status == StatusCode::OK).map(|(.., ms)| *ms).collect();
                times.sort_by(f64::total_cmp);
                println!(
                    "round={round} case={case} wave={wave} requests={requests} runs={runs} ok={ok} kept={kept} \
                     failed={failed} p50={:.1} p90={:.1} p99={:.1} max={:.1}",
                    share(&times, 0.5),
                    share(&times, 0.9),
                    share(&times, 0.99),
                    times.last().copied().unwrap_or(f64::NAN),
                );
            }
        }
    });
}

#[test]
#[ignore = "a server for a load generator"]
fn serve() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    runtime.block_on(corten::serve(App::new(url::router()).dev(false))).unwrap();
}
