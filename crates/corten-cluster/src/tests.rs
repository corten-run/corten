//! Integration tests against real Postgres and NATS (JetStream). They run when
//! `CORTEN_TEST_DATABASE_URL` and `CORTEN_TEST_NATS_URL` are set and are skipped otherwise; see
//! CONTRIBUTING.md for the containers. Each test uses its own feed keys, so they can share a database,
//! but the relay lease is one row, so run them with `--test-threads=1`.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;

use corten::feed::Change;

use super::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Item {
    id: String,
    n: i64,
}

impl Row for Item {
    fn id(&self) -> &str {
        &self.id
    }
}

/// Rows live in `test_items` (feed key, id, n).
struct Items;

impl Source for Items {
    type Row = Item;

    async fn rows(&self, conn: &mut PgConnection, key: &str) -> Result<Vec<Item>, Error> {
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT id, n FROM test_items WHERE feed = $1 ORDER BY id").bind(key).fetch_all(conn).await?;
        Ok(rows.into_iter().map(|(id, n)| Item { id, n }).collect())
    }
}

fn urls() -> Option<(String, String)> {
    Some((std::env::var("CORTEN_TEST_DATABASE_URL").ok()?, std::env::var("CORTEN_TEST_NATS_URL").ok()?))
}

async fn pool(url: &str) -> PgPool {
    let pool = PgPoolOptions::new().max_connections(8).connect(url).await.unwrap();
    migrate(&pool).await.unwrap();
    sqlx::query("CREATE TABLE IF NOT EXISTS test_items (feed text, id text, n bigint, PRIMARY KEY (feed, id))")
        .execute(&pool)
        .await
        .unwrap();
    pool
}

fn key(name: &str) -> String {
    format!("{name}{:x}", now_ms())
}

async fn new_feed(pool: &PgPool, key: &str) {
    let mut tx = pool.begin().await.unwrap();
    assert!(create_feed(&mut tx, key).await.unwrap());
    sqlx::query("INSERT INTO test_items VALUES ($1, 'a', 0)").bind(key).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

/// Sets item `a` of feed `key` to `n` as one patch, with an optional idempotency key.
async fn set(pool: &PgPool, key: &str, n: i64, idem: Option<&str>) -> Written {
    let mut write = match begin(pool, key, idem).await.unwrap() {
        Begin::Done(written) => return written,
        Begin::New(write) => write,
    };
    sqlx::query("UPDATE test_items SET n = $2 WHERE feed = $1 AND id = 'a'")
        .bind(key)
        .bind(n)
        .execute(write.conn())
        .await
        .unwrap();
    let item = Item { id: "a".into(), n };
    write.commit(&[Change::Upsert { id: "a", value: &item }]).await.unwrap()
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn take(conn: &mut PgConnection, who: &str, lease: Duration) -> bool {
    store::lease(conn, who, lease).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idempotency_key_commits_once_even_when_retries_race() {
    let Some((db, _)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let feed = key("idem");
    new_feed(&pool, &feed).await;
    let idem = format!("{feed}-k1");
    let first = set(&pool, &feed, 1, Some(&idem)).await;
    assert_eq!((first.seq, first.replayed), (Some(1), false));
    let retry = set(&pool, &feed, 99, Some(&idem)).await;
    assert_eq!((retry.seq, retry.replayed), (Some(1), true), "the retry is answered from the key");
    // Eight concurrent attempts with one new key: exactly one writes.
    let idem2 = format!("{feed}-k2");
    let attempts = (0..8).map(|n| {
        let (pool, feed, idem2) = (pool.clone(), feed.clone(), idem2.clone());
        tokio::spawn(async move { set(&pool, &feed, 10 + n, Some(&idem2)).await })
    });
    let results: Vec<Written> = futures_util::future::join_all(attempts).await.into_iter().map(Result::unwrap).collect();
    assert_eq!(results.iter().filter(|w| !w.replayed).count(), 1);
    assert!(results.iter().all(|w| w.seq == Some(2)));
    assert_eq!(seq(&pool, &feed).await.unwrap(), Some(2));
}

#[tokio::test(flavor = "multi_thread")]
async fn two_instances_converge_and_a_late_one_backfills_its_replay_log() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let feed = key("conv");
    new_feed(&pool, &feed).await;
    let options = |instance: &str| Options { instance: instance.into(), lease: Duration::from_millis(600), ..Options::default() };
    let a = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, options("a")).await.unwrap();
    let b = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, options("b")).await.unwrap();
    let (fa, fb) = (a.feed(&feed).await.unwrap().unwrap(), b.feed(&feed).await.unwrap().unwrap());
    assert!(a.feed("no-such-feed").await.unwrap().is_none());
    for n in 1..=20 {
        set(&pool, &feed, n, None).await;
    }
    eventually("both instances at seq 20", || fa.seq() == 20 && fb.seq() == 20).await;
    assert_eq!(fa.read(|r| r["a"].n), 20);
    assert_eq!(fb.read(|r| r["a"].n), 20);
    eventually("one relay", || a.relay_active() != b.relay_active()).await;
    // An instance that loads the feed now (it just started) resumes a cursor from seq 15.
    let c = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, options("c")).await.unwrap();
    let fc = c.feed(&feed).await.unwrap().unwrap();
    assert_eq!(fc.seq(), 20);
    let cursor = Since(Some(corten::feed::Cursor::new(fc.generation(), 15)));
    let body = corten::answer::Body::new(fc.live(cursor).into_body());
    let mut stream = body.into_data_stream();
    let first = futures_util::StreamExt::next(&mut stream).await.unwrap().unwrap();
    let text = String::from_utf8(first.to_vec()).unwrap();
    assert!(text.contains(&format!("id: {}-16\n", fc.generation())), "replayed from the outbox: {text}");
    assert!(!text.contains("event: sync"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_relay_lease_moves_on_when_its_holder_dies_or_stalls() {
    let Some((db, _)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let lease = Duration::from_millis(400);
    let mut x = pool.acquire().await.unwrap().detach();
    let mut y = pool.acquire().await.unwrap().detach();
    let end = Instant::now() + Duration::from_secs(10);
    while !take(&mut x, "x", lease).await {
        assert!(Instant::now() < end, "lease never became free");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!take(&mut y, "y", lease).await, "held and fresh");
    assert!(take(&mut x, "x", lease).await, "the holder renews");
    // Stalled: x stops renewing but keeps its connection. y gets the lease after it expires.
    let stalled = Instant::now();
    while !take(&mut y, "y", lease).await {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(stalled.elapsed() >= lease - Duration::from_millis(50), "not before expiry: {:?}", stalled.elapsed());
    assert!(!take(&mut x, "x", lease).await, "the stalled holder cannot renew after losing it");
    // Dead: y's connection closes. x gets the lease at once, long before expiry.
    assert!(take(&mut y, "y", lease).await);
    sqlx::Connection::close(y).await.unwrap();
    let died = Instant::now();
    while !take(&mut x, "x", lease).await {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(died.elapsed() < lease, "taken after the holder died: {:?}", died.elapsed());
    store::release(&mut x).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unused_feed_is_unloaded_and_loads_again_with_its_replay_log() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let feed = key("idle");
    new_feed(&pool, &feed).await;
    let options = Options { instance: "idle".into(), idle_unload: Some(Duration::from_millis(200)), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, options).await.unwrap();
    let loaded = cluster.feed(&feed).await.unwrap().unwrap();
    let generation = loaded.generation().to_string();

    // A live stream keeps it loaded: a handle alone does not, so without the stream the feed
    // could be unloaded (and stop following) before the relay publishes the patches.
    let stream = loaded.live(Since(Some(corten::feed::Cursor::new(&generation, 0))));
    for n in 1..=3 {
        set(&pool, &feed, n, None).await;
    }
    eventually("seq 3", || loaded.seq() == 3).await;
    drop(loaded);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(cluster.stats().iter().any(|(k, _, subscribers)| k == &feed && *subscribers == 1), "kept while streamed");

    // Without one it goes, and the next request loads it with the patches a cursor needs.
    drop(stream);
    eventually("unloaded", || !cluster.stats().iter().any(|(k, _, _)| k == &feed)).await;
    let again = cluster.feed(&feed).await.unwrap().unwrap();
    assert_eq!((again.seq(), again.generation()), (3, generation.as_str()));
    let body = corten::answer::Body::new(again.live(Since(Some(corten::feed::Cursor::new(&generation, 1)))).into_body());
    let first = futures_util::StreamExt::next(&mut body.into_data_stream()).await.unwrap().unwrap();
    let text = String::from_utf8(first.to_vec()).unwrap();
    assert!(text.contains(&format!("id: {generation}-2\n")) && !text.contains("event: sync"), "{text}");
}

/// An `Item` whose `id` stops at [`GATE`] for the row named `gate`, so a test can hold a feed's
/// build part way through a load.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Gated {
    id: String,
    n: i64,
}

impl Row for Gated {
    fn id(&self) -> &str {
        match self.id.as_str() {
            "gate" => GATE.pass(),
            "panic" => panic!("a row that cannot be read"),
            _ => {}
        }
        &self.id
    }
}

struct GatedItems;

/// How many times each feed's rows were read.
static READS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
    std::sync::LazyLock::new(Default::default);

fn reads(key: &str) -> usize {
    READS.lock().unwrap().get(key).copied().unwrap_or(0)
}

impl Source for GatedItems {
    type Row = Gated;

    async fn rows(&self, conn: &mut PgConnection, key: &str) -> Result<Vec<Gated>, Error> {
        *READS.lock().unwrap().entry(key.to_string()).or_default() += 1;
        let rows = Items.rows(conn, key).await?;
        Ok(rows.into_iter().map(|Item { id, n }| Gated { id, n }).collect())
    }
}

/// Off, armed (the next `gate` row stops), held (one has stopped) or open.
struct Gate {
    state: std::sync::Mutex<u8>,
    turn: std::sync::Condvar,
}

static GATE: Gate = Gate { state: std::sync::Mutex::new(0), turn: std::sync::Condvar::new() };

impl Gate {
    fn state(&self) -> std::sync::MutexGuard<'_, u8> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pass(&self) {
        let mut state = self.state();
        if *state != 1 {
            return;
        }
        *state = 2;
        self.turn.notify_all();
        drop(self.turn.wait_while(state, |s| *s == 2).unwrap_or_else(|e| e.into_inner()));
    }

    fn arm(&self) {
        *self.state() = 1;
    }

    /// Whether a row stopped at the gate within `within`.
    fn held(&self, within: Duration) -> bool {
        let (state, _) = self.turn.wait_timeout_while(self.state(), within, |s| *s != 2).unwrap_or_else(|e| e.into_inner());
        *state == 2
    }

    fn open(&self) {
        *self.state() = 3;
        self.turn.notify_all();
    }
}

/// Opens the gate when dropped, so a failed assertion does not leave a load stopped forever.
struct OpenOnDrop;

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        GATE.open();
    }
}

/// Runs `f` on its own thread and waits up to ten seconds for it: a call that waits on a lock held
/// elsewhere blocks that thread, not the test's.
async fn within_ten_seconds<R: Send + 'static>(f: impl std::future::Future<Output = R> + Send + 'static) -> Option<R> {
    let (tx, rx) = std::sync::mpsc::channel();
    let runtime = tokio::runtime::Handle::current();
    std::thread::spawn(move || {
        let _ = tx.send(runtime.block_on(f));
    });
    tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(10)).ok()).await.unwrap()
}

// The gate blocks the thread it stops on; give the test more than one even on one CPU.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_feed_being_built_does_not_hold_up_requests_or_patches_for_other_feeds() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let (small, big) = (key("small"), key("big"));
    new_feed(&pool, &small).await;
    new_feed(&pool, &big).await;
    sqlx::query("INSERT INTO test_items VALUES ($1, 'gate', 0)").bind(&big).execute(&pool).await.unwrap();
    let options = Options { instance: "gated".into(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), GatedItems, options).await.unwrap();
    let small_feed = cluster.feed(&small).await.unwrap().unwrap();

    // Stop the big feed's build at its `gate` row, after its rows were read.
    let _open = OpenOnDrop;
    GATE.arm();
    let loading = tokio::spawn({
        let (cluster, big) = (cluster.clone(), big.clone());
        async move { cluster.feed(&big).await.map(|f| f.map(|f| (f.seq(), f.read(|r| r["a"].n)))) }
    });
    assert!(tokio::task::spawn_blocking(|| GATE.held(Duration::from_secs(10))).await.unwrap(), "the build reached the gate");

    // Meanwhile another feed is found, and a patch for it is applied.
    let found = within_ten_seconds({
        let (cluster, small) = (cluster.clone(), small.clone());
        async move { cluster.feed(&small).await.map(|f| f.is_some()) }
    })
    .await;
    assert!(matches!(found, Some(Ok(true))), "another feed is found while one is built: {found:?}");
    set(&pool, &small, 1, None).await;
    eventually("a patch for another feed", || small_feed.seq() == 1).await;
    // A patch for the feed being built waits in its buffer and is applied after the build.
    set(&pool, &big, 7, None).await;
    eventually("the patch buffered", || cluster.hub.buffered(&big) == 1).await;

    GATE.open();
    let loaded = loading.await.unwrap().unwrap().unwrap();
    let big_feed = cluster.feed(&big).await.unwrap().unwrap();
    eventually("the buffered patch", || big_feed.seq() == 1).await;
    assert_eq!(big_feed.read(|r| r["a"].n), 7, "loaded as {loaded:?}");
}

// The gate blocks the thread it stops on; give the test more than one even on one CPU.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_load_outlives_its_request_and_a_build_that_panics_does_not_leave_the_feed_stuck() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let (dropped, broken) = (key("dropped"), key("broken"));
    new_feed(&pool, &dropped).await;
    sqlx::query("INSERT INTO test_items VALUES ($1, 'gate', 0)").bind(&dropped).execute(&pool).await.unwrap();
    new_feed(&pool, &broken).await;
    sqlx::query("INSERT INTO test_items VALUES ($1, 'panic', 0)").bind(&broken).execute(&pool).await.unwrap();
    let options = Options { instance: "unfinished".into(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), GatedItems, options).await.unwrap();

    // The request that started a load goes away while its feed is built: the load goes on, and the
    // next request gets its feed.
    let _open = OpenOnDrop;
    GATE.arm();
    let first = tokio::spawn({
        let (cluster, dropped) = (cluster.clone(), dropped.clone());
        async move { cluster.feed(&dropped).await.map(|f| f.is_some()) }
    });
    assert!(tokio::task::spawn_blocking(|| GATE.held(Duration::from_secs(10))).await.unwrap(), "the build reached the gate");
    first.abort();
    let _ = first.await;
    let again = tokio::spawn({
        let (cluster, dropped) = (cluster.clone(), dropped.clone());
        async move { cluster.feed(&dropped).await.map(|f| f.is_some()).map_err(|e| e.to_string()) }
    });
    GATE.open();
    let again = tokio::time::timeout(Duration::from_secs(10), again).await;
    assert!(matches!(again, Ok(Ok(Ok(true)))), "the next request gets the feed that load built: {again:?}");
    assert_eq!(reads(&dropped), 1, "one load, not a second one for the next request");

    // A build that panics is an error for its request, and the next request tries again.
    for attempt in 1..=2 {
        let answer = within_ten_seconds({
            let (cluster, broken) = (cluster.clone(), broken.clone());
            async move { cluster.feed(&broken).await.map(|f| f.is_some()).map_err(|e| e.to_string()) }
        })
        .await;
        assert!(matches!(&answer, Some(Err(e)) if e.contains("panicked")), "attempt {attempt}: {answer:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reload_reads_the_rows_again_and_one_that_panics_sends_its_clients_to_resync() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let feed = key("reload");
    new_feed(&pool, &feed).await;
    let options = Options { instance: "reloads".into(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), GatedItems, options).await.unwrap();
    let loaded = cluster.feed(&feed).await.unwrap().unwrap();

    // A row that reached Postgres without a patch (as one lost in a gap) is there after a reload,
    // in the same feed, which requests are handed throughout.
    sqlx::query("INSERT INTO test_items VALUES ($1, 'b', 2)").bind(&feed).execute(&pool).await.unwrap();
    let mut done = cluster.hub.reload(&feed).expect("reloading");
    assert!(cluster.feed(&feed).await.unwrap().is_some(), "served while it reloads");
    done.wait_for(|d| *d).await.unwrap();
    assert!(loaded.read(|rows| rows.contains_key("b")), "the same feed has the row");

    // One whose build panics does not go on serving a feed that no longer follows its patches: its
    // clients resync, and requests get the error as a first load's would.
    sqlx::query("INSERT INTO test_items VALUES ($1, 'panic', 0)").bind(&feed).execute(&pool).await.unwrap();
    let mut live = corten::answer::Body::new(
        loaded.live(Since(Some(corten::feed::Cursor::new(loaded.generation(), loaded.seq())))).into_body(),
    )
    .into_data_stream();
    let mut done = cluster.hub.reload(&feed).expect("reloading");
    tokio::time::timeout(Duration::from_secs(10), done.wait_for(|d| *d)).await.expect("the reload ends").unwrap();
    let synced = tokio::time::timeout(Duration::from_secs(10), async {
        let mut text = String::new();
        while let Some(Ok(chunk)) = futures_util::StreamExt::next(&mut live).await {
            text.push_str(&String::from_utf8_lossy(&chunk));
        }
        text
    })
    .await
    .expect("the live stream ends");
    assert!(synced.contains("event: sync"), "{synced}");
    let reads_before = reads(&feed);
    let answer = cluster.feed(&feed).await.map(|f| f.is_some()).map_err(|e| e.to_string());
    assert!(matches!(&answer, Err(e) if e.contains("panicked")), "{answer:?}");
    assert_eq!(reads(&feed), reads_before + 1, "the request loaded it again; nothing else did");
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(reads(&feed), reads_before + 1, "no reload of its own after the panic");
}

/// How long finding a loaded feed takes while another, of 100,000 rows (`STALL_ROWS` to change it), loads: five loads, each
/// sampled by a thread that asks for the small feed back to back (each ask a task on the runtime's
/// workers, as a request is) until the load is done, and
/// then a reload of it (as after a gap) sampled the same way, and before them an idle 300 ms, the noise floor (the sampling thread descheduled; shorter than most
/// loads, so its maximum understates the noise).
/// `stalled` is the time spent in asks that took over a millisecond. Run in release to compare two
/// builds:
/// `cargo test --release -p corten-cluster -- --ignored --nocapture finding_a_feed_while_a_large_one_loads`
#[test]
#[ignore]
fn finding_a_feed_while_a_large_one_loads() {
    // `STALL_WORKERS` worker threads (one per CPU unless set), as an app's runtime has.
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    if let Some(workers) = std::env::var("STALL_WORKERS").ok().and_then(|n| n.parse().ok()) {
        runtime.worker_threads(workers);
    }
    runtime.enable_all().build().unwrap().block_on(finding_a_feed_while_a_large_one_loads_on());
}

async fn finding_a_feed_while_a_large_one_loads_on() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let rows: i64 = std::env::var("STALL_ROWS").ok().and_then(|n| n.parse().ok()).unwrap_or(100_000);
    let small = key("asked");
    new_feed(&pool, &small).await;
    let options = Options { instance: "stall".into(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, options).await.unwrap();
    cluster.feed(&small).await.unwrap().unwrap();
    let sample = |stop: Arc<std::sync::atomic::AtomicBool>| {
        let (cluster, small, runtime) = (cluster.clone(), small.clone(), tokio::runtime::Handle::current());
        std::thread::spawn(move || {
            let mut times = Vec::new();
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let started = Instant::now();
                // On a worker, as a request is: a worker held up by a load holds this up too.
                let (cluster, small) = (cluster.clone(), small.clone());
                runtime.block_on(runtime.spawn(async move { cluster.feed(&small).await.map(|f| f.is_some()) })).unwrap().unwrap();
                times.push(started.elapsed());
            }
            let stalled: Duration = times.iter().filter(|t| **t > Duration::from_millis(1)).sum();
            (times.iter().max().copied().unwrap_or_default(), stalled)
        })
    };
    for run in 1..=5 {
        let big = key("large");
        new_feed(&pool, &big).await;
        sqlx::query("INSERT INTO test_items SELECT $1, 'r' || g, g FROM generate_series(1, $2) g")
            .bind(&big)
            .bind(rows)
            .execute(&pool)
            .await
            .unwrap();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let idle = sample(stop.clone());
        tokio::time::sleep(Duration::from_millis(300)).await;
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (idle_max, idle_stalled) = idle.join().unwrap();
        // The first load, then a reload (as after a gap), each started on a worker as a request's is.
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let during = sample(stop.clone());
        let started = Instant::now();
        let first = tokio::spawn({
            let (cluster, big) = (cluster.clone(), big.clone());
            async move { cluster.feed(&big).await.map(|f| f.is_some()) }
        });
        assert!(first.await.unwrap().unwrap());
        let load = started.elapsed();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (max, stalled) = during.join().unwrap();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let during = sample(stop.clone());
        let started = Instant::now();
        let mut reloaded = cluster.hub.reload(&big).expect("reloading");
        reloaded.wait_for(|done| *done).await.unwrap();
        let reload = started.elapsed();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let (reload_max, reload_stalled) = during.join().unwrap();
        println!(
            "run {run}, {rows} rows: load {load:?}; finding the small feed: max {max:?}, stalled {stalled:?}; reload {reload:?}: max {reload_max:?}, stalled {reload_stalled:?}; idle 300ms: max {idle_max:?}, stalled {idle_stalled:?}"
        );
        sqlx::query("DELETE FROM test_items WHERE feed = $1").bind(&big).execute(&pool).await.unwrap();
    }
}

/// The feed's routes as an app serves them.
#[corten::routes(state = Cluster<Items>)]
mod url {
    #[route("/feeds/{key}", get = feed_snapshot, rows = Item)]
    pub struct FeedUrl<'a> {
        pub key: &'a str,
    }
}

async fn feed_snapshot(
    corten::prelude::State(cluster): corten::prelude::State<Cluster<Items>>,
    corten::Params(feed): corten::Params<url::FeedUrl<'_>>,
) -> corten::Result<FeedResponse<Item>> {
    cluster.snapshot(&feed.key).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_feed_route_answers_a_snapshot_and_json_404_for_a_feed_that_does_not_exist() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let feed = key("route");
    new_feed(&pool, &feed).await;
    let options = Options { instance: "route".into(), ..Options::default() };
    let cluster = Cluster::start(pool, async_nats::connect(&nats).await.unwrap(), Items, options).await.unwrap();
    let app = corten::App::new(url::router(cluster.clone())).test();
    let get = async |key: &str| {
        let res = app.get(&url::FeedUrl { key }).await;
        (res.status(), res.headers()["content-type"].to_str().unwrap().to_string(), res.text().to_string())
    };
    let (status, _, body) = get(&feed).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(r#""id":"a""#), "{body}");
    // A browser asked too (no Accept for JSON): a feed's route answers its failures as JSON.
    let (status, kind, body) = get(&key("missing")).await;
    assert_eq!((status, kind.as_str()), (StatusCode::NOT_FOUND, "application/problem+json"));
    assert!(body.contains(r#""status":404"#) && body.contains("no feed missing"), "{body}");
}
