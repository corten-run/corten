//! Integration tests against real Postgres and NATS (JetStream). They run when
//! `CORTEN_TEST_DATABASE_URL` and `CORTEN_TEST_NATS_URL` are set and are skipped otherwise; see
//! CONTRIBUTING.md for the containers. Each test uses its own feed keys, so they can share a database,
//! but the relay lease is one row, so run them with `--test-threads=1`.

use std::{
    future::{poll_fn, Future},
    sync::Mutex,
    task::Poll,
    time::{Duration, Instant},
};

use async_nats::jetstream::{
    self,
    consumer::{
        pull::{Ordered, OrderedConfig},
        DeliverPolicy,
    },
};
use futures_util::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{oneshot, Semaphore},
};

use corten::feed::Change;

use super::*;

/// Each feed event as "LEVEL target field=value ..", in the order they came.
#[derive(Clone, Default)]
pub(super) struct Capture(pub(super) Arc<Mutex<Vec<String>>>);

impl tracing::Subscriber for Capture {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target() == "corten::feed"
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        struct Fields(String);
        impl tracing::field::Visit for Fields {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                use std::fmt::Write;
                let _ = write!(self.0, " {}={value:?}", field.name());
            }
        }
        let mut fields = Fields(format!("{} {}", event.metadata().level(), event.metadata().target()));
        event.record(&mut fields);
        self.0.lock().unwrap().push(fields.0);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[test]
fn nats_header_line_breaks_do_not_panic() {
    // A received header's value is read into a `String` and appended through
    // `IntoHeaderValue`, as here. On async-nats 0.50 that panicked on a carriage return,
    // stopping the subscriber's connection task; 0.52 replaces it with a space.
    let received = String::from("first\rsecond");
    let mut headers = async_nats::HeaderMap::new();
    headers.append("X-Test", received);
    assert_eq!(headers.get("X-Test").unwrap().as_str(), "first second");
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Row)]
struct Item {
    #[row(id)]
    id: String,
    n: i64,
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
    test_items(&pool).await;
    pool
}

async fn test_items(pool: &PgPool) {
    sqlx::query("CREATE TABLE IF NOT EXISTS test_items (feed text, id text, n bigint, PRIMARY KEY (feed, id))")
        .execute(pool)
        .await
        .unwrap();
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

/// Keys that are not literal NATS subjects: empty tokens, whitespace (including the framing
/// bytes and Unicode spaces), control characters (NUL also stops Postgres), the subscription
/// wildcards, and keys over Corten's 1,024-byte limit.
fn bad_keys() -> Vec<String> {
    let mut keys: Vec<String> = [
        "my feed",
        "",
        ".x",
        "x.",
        "a..b",
        "a\tb",
        "a\rb",
        "a\nb",
        "a\u{b}b",
        "a\u{c}b",
        "a\u{a0}b",
        "a\u{2028}b",
        "a\0b",
        "a\u{7f}b",
        "a\u{85}b",
        "*",
        ">",
        "a*b",
        "a>b",
        "a.>",
    ]
    .map(String::from)
    .into();
    keys.push("a".repeat(5000));
    keys.push("\u{e9}".repeat(2500));
    keys.push(long_key(1025));
    keys
}

#[test]
fn feed_keys_are_literal_nats_subjects() {
    for key in ["listings", "sellers.42", "a-b_c", "caf\u{e9}.\u{5e02}\u{5834}", "a:b", "x/y"] {
        assert!(check_key(key).is_ok(), "refused {key:?}");
        // Never wider than the client's own structural check.
        assert!(async_nats::Subject::from(key).is_valid(), "{key:?}");
    }
    for key in bad_keys() {
        assert!(check_key(&key).unwrap_err().is::<InvalidFeedKey>(), "accepted {key:?}");
    }
    // The byte limit, whatever the characters.
    assert!(check_key(&"k".repeat(MAX_FEED_KEY_BYTES)).is_ok());
    assert!(check_key(&long_key(1024)).is_ok());
    assert!(check_key(&format!("{}\u{e9}", "k".repeat(MAX_FEED_KEY_BYTES - 2))).is_ok());
    assert!(check_key(&"k".repeat(MAX_FEED_KEY_BYTES + 1)).is_err());
    assert!(check_key(&format!("{}\u{e9}", "k".repeat(MAX_FEED_KEY_BYTES - 1))).is_err());
}

#[tokio::test]
async fn begin_refuses_an_invalid_key_before_it_opens_a_transaction() {
    // Nothing listens there: reaching the database would fail with a connection error instead.
    let pool = PgPoolOptions::new().connect_lazy("postgres://corten@127.0.0.1:1/none").unwrap();
    for key in bad_keys() {
        let error = begin(&pool, &key, Some("idem")).await.err().expect("refused");
        assert!(error.is::<InvalidFeedKey>(), "{key:?}: {error}");
    }
}

#[tokio::test]
async fn invalid_feed_keys_are_refused_before_the_insert() {
    let Some((db, _)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let mut tx = pool.begin().await.unwrap();
    for key in bad_keys() {
        let error = create_feed(&mut tx, &key).await.err().unwrap_or_else(|| panic!("accepted {key:?}"));
        assert!(error.is::<InvalidFeedKey>(), "{key:?}: {error}");
        if key.contains('\0') {
            continue; // Postgres cannot bind it, so it cannot be looked up either.
        }
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM corten_feeds WHERE key = $1)")
            .bind(&key)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert!(!exists, "inserted {key:?}");
    }
    let valid = key("valid.caf\u{e9}.part-_");
    assert!(create_feed(&mut tx, &valid).await.unwrap(), "the transaction is still usable");
    assert!(!create_feed(&mut tx, &valid).await.unwrap());
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn an_invalid_subject_prefix_is_refused_before_migration() {
    let Some((_, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    // Nothing listens there: migrating first would fail with a connection error instead.
    let pool = PgPoolOptions::new().connect_lazy("postgres://corten@127.0.0.1:1/none").unwrap();
    let long = "p".repeat(256);
    for prefix in ["", "corten feeds", "corten.", "corten..feeds", "corten.*", "corten.>", "corten\u{a0}feeds", "corten\0", &long]
    {
        let options = Options { subject_prefix: prefix.into(), ..Options::default() };
        let started = Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, options).await;
        let error = started.err().unwrap_or_else(|| panic!("accepted {prefix:?}")).to_string();
        assert!(error.contains("subject_prefix"), "{prefix:?}: {error}");
    }
}

#[tokio::test]
async fn an_over_budget_reply_inbox_is_refused_before_migration() {
    let Some((_, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    // Nothing listens there: migrating first would fail with a connection error instead.
    let pool = PgPoolOptions::new().connect_lazy("postgres://corten@127.0.0.1:1/none").unwrap();
    let nats = async_nats::ConnectOptions::new().custom_inbox_prefix("r".repeat(2730)).connect(&nats).await.unwrap();
    let started = Cluster::start(pool, nats, Items, Options::default()).await;
    let error = started.err().expect("refused").to_string();
    assert!(error.contains("reply inbox uses 2753 bytes"), "{error}");
    assert!(error.contains("max_control_line=4096 allows at most 2752 bytes"), "{error}");
}

/// A pool on an isolated schema so legacy rows cannot affect the other relay tests.
async fn schema_pool(url: &str, schema: &str) -> PgPool {
    let admin = PgPool::connect(url).await.unwrap();
    sqlx::query(&format!("CREATE SCHEMA {schema}")).execute(&admin).await.unwrap();
    admin.close().await;
    let options = url.parse::<PgConnectOptions>().unwrap().options([("search_path", schema)]);
    PgPoolOptions::new().max_connections(8).connect_with(options).await.unwrap()
}

/// Deterministic, low-compressibility ASCII for exercising the real B-tree indexes.
fn long_key(len: usize) -> String {
    let alphabet = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut state = 0xa3b1_c2d3_u32;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            char::from(alphabet[state as usize % alphabet.len()])
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_relay_drops_legacy_invalid_keys_and_delivers_good_rows_in_order() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("legacy_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();

    let good = long_key(1024);
    let too_long = long_key(1025);
    let mut tx = pool.begin().await.unwrap();
    assert!(create_feed(&mut tx, &good).await.unwrap());
    sqlx::query("UPDATE corten_feeds SET seq = 3 WHERE key = $1").bind(&good).execute(&mut *tx).await.unwrap();
    for bad in ["old key", &too_long] {
        sqlx::query("INSERT INTO corten_feeds (key, generation, seq) VALUES ($1, 'g', 1)")
            .bind(bad)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    // Commit as one batch before starting any relay. Both later good rows must get past both bad keys.
    for (feed, seq) in [(&*good, 1_i64), ("old key", 1), (&too_long, 1), (&good, 2), (&good, 3)] {
        sqlx::query(
            "INSERT INTO corten_outbox (feed, generation, seq, body)
             SELECT key, generation, $2, $3 FROM corten_feeds WHERE key = $1",
        )
        .bind(feed)
        .bind(seq)
        .bind(format!(r#"{{"seq":{seq},"changes":[]}}"#))
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let prefix = format!("{schema}{}", "p".repeat(255 - schema.len()));
    let stream_name = schema.to_uppercase();
    let options = Options { stream: stream_name.clone(), subject_prefix: prefix.clone(), ..Options::default() };
    let nats = async_nats::ConnectOptions::new().custom_inbox_prefix("r".repeat(2729)).connect(&nats).await.unwrap();
    let cluster = Cluster::start(pool.clone(), nats.clone(), Items, options).await.unwrap();
    let js = async_nats::jetstream::new(nats);
    let mut stream = js.get_stream(&stream_name).await.unwrap();
    let consumer =
        stream.create_consumer(OrderedConfig { deliver_policy: DeliverPolicy::All, ..Default::default() }).await.unwrap();
    let mut messages = consumer.messages().await.unwrap();
    let subject = format!("{prefix}.{good}");
    for seq in 1..=3 {
        let msg = tokio::time::timeout(Duration::from_secs(10), messages.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for good patch {seq}"))
            .unwrap()
            .unwrap();
        assert_eq!(msg.subject.as_str(), subject);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&msg.payload).unwrap()["seq"], seq);
    }

    let end = Instant::now() + Duration::from_secs(10);
    while !store::pending(&pool, 10).await.unwrap().is_empty() {
        assert!(Instant::now() < end, "outbox rows not marked done");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(stream.info().await.unwrap().state.messages, 3, "only valid rows were published");
    assert!(cluster.feed("old key").await.unwrap().is_none());
    assert!(cluster.feed(&too_long).await.unwrap().is_none());

    js.delete_stream(&stream_name).await.unwrap();
    let admin = PgPool::connect(&db).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&admin).await.unwrap();
}

// Single-threaded so the relay task runs with the test's tracing subscriber.
#[tokio::test]
async fn a_stream_size_refusal_reloads_ready_and_loading_followers_without_a_later_patch() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    const STREAM_LIMIT: i32 = 512;
    let logs = Capture::default();
    let _capture = tracing::subscriber::set_default(logs.clone());
    let schema = key("size_limit_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    test_items(&pool).await;
    new_feed(&pool, "large").await;
    new_feed(&pool, "small").await;
    sqlx::query("INSERT INTO test_items VALUES ('large', 'gate', 0)").execute(&pool).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE retirement_batches (rows bigint);
         CREATE FUNCTION count_retired() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
             INSERT INTO retirement_batches SELECT count(*) FROM updated HAVING count(*) > 0;
             RETURN NULL;
         END $$;
         CREATE TRIGGER count_retired AFTER UPDATE ON corten_outbox
             REFERENCING NEW TABLE AS updated FOR EACH STATEMENT EXECUTE FUNCTION count_retired();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let nats = async_nats::connect(&nats).await.unwrap();
    let js = jetstream::new(nats.clone());
    let stream_name = schema.to_uppercase();
    let mut stream = js
        .create_stream(jetstream::stream::Config {
            name: stream_name.clone(),
            subjects: vec![format!("{schema}.>")],
            max_message_size: STREAM_LIMIT,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut gate = pool.acquire().await.unwrap().detach();
    assert!(take(&mut gate, "test", Duration::from_secs(30)).await);
    let options = Options { stream: stream_name.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), nats.clone(), Items, options.clone()).await.unwrap();
    let cold = hub::Hub::new(pool.clone(), Items, Arc::new(options.clone()));
    hub::start(cold.clone(), js.clone()).await.unwrap();
    let loading_cluster = Cluster::start(pool.clone(), nats.clone(), GatedItems, options).await.unwrap();
    let followed = cluster.feed("large").await.unwrap().unwrap();
    let small = cluster.feed("small").await.unwrap().unwrap();
    assert_eq!(followed.seq(), 0);
    let mut live =
        corten::http::Body::new(followed.live(Since(Some(corten::feed::Cursor::new(followed.generation(), 0)))).into_body())
            .into_data_stream();
    let opening = live.next().await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&opening).starts_with("retry:"));
    let _open = OpenOnDrop;
    GATE.arm();
    let loading = tokio::spawn({
        let cluster = loading_cluster.clone();
        async move { cluster.feed("large").await.unwrap().unwrap() }
    });
    assert!(tokio::task::spawn_blocking(|| GATE.held(Duration::from_secs(10))).await.unwrap());

    let item = Item { id: "x".repeat(2 * STREAM_LIMIT as usize), n: 2 };
    let Begin::New(mut write) = begin(&pool, "large", None).await.unwrap() else { unreachable!() };
    sqlx::query("INSERT INTO test_items VALUES ('large', $1, $2)")
        .bind(&item.id)
        .bind(item.n)
        .execute(write.conn())
        .await
        .unwrap();
    let change = Change::Upsert { id: &item.id, value: &item };
    let body = corten::feed::patch_json(1, std::slice::from_ref(&change));
    assert!(body.len() > STREAM_LIMIT as usize && body.len() + 128 < nats.max_payload());
    let refusal = js.publish(format!("{schema}.probe"), body.into()).await.unwrap().await.unwrap_err();
    assert_eq!(
        std::error::Error::source(&refusal).unwrap().downcast_ref::<jetstream::Error>().unwrap().error_code(),
        jetstream::ErrorCode::STREAM_MESSAGE_EXCEEDS_MAXIMUM
    );
    assert_eq!(write.commit(&[change]).await.unwrap().seq, Some(1));
    assert_eq!(set(&pool, "small", 1, None).await.seq, Some(1));
    let pending = wait_pending(&pool, 2).await;
    store::release(&mut gate).await.unwrap();

    let mut messages = stream_messages(&stream).await;
    expect_patch(&mut messages, &format!("{schema}.small"), 1, 1).await;
    expect_reload(&mut messages, &format!("{schema}.large"), &pending[0]).await;
    eventually("the other feed's patch and the buffered marker", || {
        small.seq() == 1 && loading_cluster.hub.buffered("large") == 1
    })
    .await;
    GATE.open();
    let loaded = loading.await.unwrap();
    wait_pending(&pool, 0).await;
    let retired: Vec<i64> = sqlx::query_scalar("SELECT rows FROM retirement_batches").fetch_all(&pool).await.unwrap();
    assert_eq!(retired, [2], "one update for the acknowledged patch and marker");
    let state = &stream.info().await.unwrap().state;
    assert_eq!((state.first_sequence, state.last_sequence, state.messages), (1, 2, 2));
    eventually("both followers to reload the final patch", || followed.seq() == 1 && loaded.seq() == 1).await;
    assert_eq!(followed.read(|rows| rows[&item.id].n), 2);
    assert_eq!(loaded.read(|rows| rows[&item.id].n), 2);
    let sync = tokio::time::timeout(Duration::from_secs(10), live.next()).await.unwrap().unwrap().unwrap();
    assert!(String::from_utf8_lossy(&sync).contains("event: sync"));
    let log = expect_reload_log(&pool, &pending[0], &logs, "JetStream size refusal (10054)").await;
    assert!(log.contains(&format!("stream_max_message_size={STREAM_LIMIT}")), "{log}");
    assert_eq!(nats.statistics().connects.load(Ordering::Relaxed), 1);

    let cold = cold.feed("large").await.unwrap().unwrap();
    assert_eq!(cold.seq(), 1);
    assert_eq!(cold.read(|rows| rows[&item.id].n), 2);

    let cursor = || Since(Some(corten::feed::Cursor::new(followed.generation(), followed.seq())));
    let mut resumed = [followed.live(cursor()).into_body(), loaded.live(cursor()).into_body()]
        .map(|body| corten::http::Body::new(body).into_data_stream());
    for live in &mut resumed {
        let opening = live.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&opening).starts_with("retry:"));
    }
    assert_eq!(set(&pool, "large", 3, None).await.seq, Some(2));
    expect_patch(&mut messages, &format!("{schema}.large"), 3, 2).await;
    for mut live in resumed {
        let frame = tokio::time::timeout(Duration::from_secs(10), live.next()).await.unwrap().unwrap().unwrap();
        let frame = std::str::from_utf8(&frame).unwrap();
        let patch = format!("event: patch\nid: {}-2\ndata: ", followed.generation());
        let body = frame.strip_prefix(&patch).unwrap_or_else(|| panic!("expected a patch frame, got {frame}"));
        let patch: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(patch["seq"], 2);
        assert_eq!(patch["changes"][0]["value"]["n"], 3);
    }
    eventually("all followers to apply the next patch", || followed.seq() == 2 && loaded.seq() == 2 && cold.seq() == 2).await;
    assert_eq!(followed.read(|rows| (rows[&item.id].n, rows["a"].n)), (2, 3));
    assert_eq!(loaded.read(|rows| (rows[&item.id].n, rows["a"].n)), (2, 3));
    assert_eq!(cold.read(|rows| (rows[&item.id].n, rows["a"].n)), (2, 3));
    wait_pending(&pool, 0).await;
    delete_test_stream_and_schema(&db, &js, &stream_name, &schema).await;
}

const LOW_PAYLOAD: usize = 4096;

/// Relay one connection to the real broker, substituting a stale-low initial INFO.
async fn payload_proxy(listener: TcpListener, upstream: async_nats::ServerAddr, max_payload: usize) {
    let (mut client, _) = listener.accept().await.unwrap();
    let mut server = advertise_payload(&mut client, &upstream, max_payload).await;
    tokio::io::copy_bidirectional(&mut client, &mut server).await.unwrap();
}

async fn advertise_payload(
    client: &mut TcpStream,
    upstream: &async_nats::ServerAddr,
    max_payload: usize,
) -> BufReader<TcpStream> {
    let mut server = BufReader::new(TcpStream::connect((upstream.host(), upstream.port())).await.unwrap());
    let mut info = String::new();
    server.read_line(&mut info).await.unwrap();
    let mut advertised: serde_json::Value = serde_json::from_str(info.strip_prefix("INFO ").unwrap()).unwrap();
    advertised["max_payload"] = max_payload.into();
    client.write_all(format!("INFO {advertised}\r\n").as_bytes()).await.unwrap();

    // Keep the advertised limit stale: protocol 0 does not receive asynchronous INFO updates.
    // Read only CONNECT, leaving the rest for the proxy to forward.
    let mut line = String::new();
    BufReader::with_capacity(1, client).read_line(&mut line).await.unwrap();
    let mut connect: serde_json::Value = serde_json::from_str(line.strip_prefix("CONNECT ").unwrap()).unwrap();
    connect["protocol"] = 0.into();
    server.write_all(format!("CONNECT {connect}\r\n").as_bytes()).await.unwrap();

    server
}

// Single-threaded so the relay task runs with the test's tracing subscriber.
#[tokio::test]
async fn a_cached_payload_refusal_reloads_followers_without_reconnecting() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let logs = Capture::default();
    let _capture = tracing::subscriber::set_default(logs.clone());
    let schema = key("cached_limit_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    let observer = async_nats::connect(&nats).await.unwrap();
    let js = jetstream::new(observer.clone());
    let stream_name = schema.to_uppercase();
    let mut stream = js
        .create_stream(jetstream::stream::Config {
            name: stream_name.clone(),
            subjects: vec![format!("{schema}.>")],
            ..Default::default()
        })
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap().to_string();
    let proxy = tokio::spawn(payload_proxy(listener, nats.parse().unwrap(), LOW_PAYLOAD));
    let publisher = async_nats::ConnectOptions::new().ignore_discovered_servers().connect(proxy_addr).await.unwrap();
    assert_eq!(publisher.max_payload(), LOW_PAYLOAD);

    test_items(&pool).await;
    new_feed(&pool, "large").await;
    new_feed(&pool, "small").await;
    let mut gate = pool.acquire().await.unwrap().detach();
    assert!(take(&mut gate, "test", Duration::from_secs(30)).await);
    let options = Options { stream: stream_name.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), publisher.clone(), Items, options.clone()).await.unwrap();
    let peer = hub::Hub::new(pool.clone(), Items, Arc::new(options));
    hub::start(peer.clone(), js.clone()).await.unwrap();
    let large_follower = cluster.feed("large").await.unwrap().unwrap();
    let small_follower = cluster.feed("small").await.unwrap().unwrap();
    let peer_follower = peer.feed("large").await.unwrap().unwrap();
    assert_eq!((large_follower.seq(), small_follower.seq()), (0, 0));

    let item = Item { id: "x".repeat(LOW_PAYLOAD), n: 2 };
    let Begin::New(mut write) = begin(&pool, "large", None).await.unwrap() else { unreachable!() };
    sqlx::query("INSERT INTO test_items VALUES ('large', $1, $2)")
        .bind(&item.id)
        .bind(item.n)
        .execute(write.conn())
        .await
        .unwrap();
    assert_eq!(write.commit(&[Change::Upsert { id: &item.id, value: &item }]).await.unwrap().seq, Some(1));
    assert_eq!(set(&pool, "small", 1, None).await.seq, Some(1));
    let pending = wait_pending(&pool, 2).await;
    let refused = &pending[0];
    assert_eq!((refused.feed.as_str(), refused.seq), ("large", 1));
    assert!(refused.body.len() > LOW_PAYLOAD && refused.body.len() + 128 < observer.max_payload());
    store::release(&mut gate).await.unwrap();

    let mut messages = stream_messages(&stream).await;
    let large = format!("{schema}.large");
    let small = format!("{schema}.small");
    expect_patch(&mut messages, &small, 1, 1).await;
    expect_reload(&mut messages, &large, refused).await;
    eventually("both followers to reload the final patch", || large_follower.seq() == 1 && peer_follower.seq() == 1).await;
    assert_eq!(large_follower.read(|rows| rows[&item.id].n), 2);
    assert_eq!(peer_follower.read(|rows| rows[&item.id].n), 2);

    assert_eq!(set(&pool, "small", 2, None).await.seq, Some(2));
    expect_patch(&mut messages, &small, 3, 2).await;
    eventually("the other feed's next write", || small_follower.seq() == 2).await;
    assert_eq!(small_follower.read(|rows| rows["a"].n), 2);
    wait_pending(&pool, 0).await;
    let log = expect_reload_log(&pool, refused, &logs, "refused by the connection's cached limit").await;
    let size = log
        .split_once(&format!("Payload size limit of {LOW_PAYLOAD} exceeded by message size of "))
        .and_then(|(_, size)| size.split_whitespace().next())
        .and_then(|size| size.parse::<usize>().ok())
        .unwrap_or_else(|| panic!("missing checked publish size: {log}"));
    assert!(size > refused.body.len() && size < observer.max_payload(), "{log}");
    assert_eq!(stream.info().await.unwrap().state.messages, 3);
    // The cached refusal was stale: the same broker and stream accept the full patch
    // when sent by a client with the real limit (on a probe subject, not the live feed).
    js.publish(format!("{schema}.probe"), refused.body.clone().into()).await.unwrap().await.unwrap();
    publisher.flush().await.unwrap();
    assert_eq!(publisher.max_payload(), LOW_PAYLOAD);
    assert_eq!(publisher.statistics().connects.load(Ordering::Relaxed), 1);
    assert!(!proxy.is_finished(), "the original publisher connection must still be open");
    proxy.abort();
    delete_test_stream_and_schema(&db, &js, &stream_name, &schema).await;
}

async fn expect_reload_log(pool: &PgPool, row: &store::Pending, logs: &Capture, reason: &str) -> String {
    expect_retirement_log(pool, row, logs, &format!("published reload marker: {reason}; patch kept for inspection")).await
}

async fn expect_retirement_log(pool: &PgPool, row: &store::Pending, logs: &Capture, message: &str) -> String {
    let (body, done): (String, bool) = sqlx::query_as("SELECT body, published_at IS NOT NULL FROM corten_outbox WHERE id = $1")
        .bind(row.id)
        .fetch_one(pool)
        .await
        .expect("the original patch is still in Postgres");
    assert!(done);
    assert_eq!(body, row.body);
    let message = format!("ERROR corten::feed message={message}");
    let fields = format!("id={} feed={:?} patch_bytes={}", row.id, row.feed, row.body.len());
    let seen = logs.0.lock().unwrap();
    let mut matching = seen.iter().filter(|line| line.starts_with(&message) && line.contains(&fields));
    let log = matching.next().unwrap_or_else(|| panic!("missing reload marker log for {fields}: {seen:?}"));
    assert!(matching.next().is_none(), "duplicate retirement log for {fields}: {seen:?}");
    log.clone()
}

async fn expect_reload(messages: &mut Ordered, subject: &str, row: &store::Pending) {
    let msg = tokio::time::timeout(Duration::from_secs(10), messages.next())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for reload marker on {subject}"))
        .unwrap()
        .unwrap();
    assert_eq!(msg.subject.as_str(), subject);
    assert!(msg.payload.is_empty());
    let headers = msg.headers.as_ref().unwrap();
    assert_eq!(headers.get("Corten-Reload").unwrap().as_str(), row.seq.to_string());
    assert_eq!(headers.get("Feed-Generation").unwrap().as_str(), row.generation);
    assert_eq!(headers.get("Nats-Msg-Id").unwrap().as_str(), format!("{}:{}:{}", row.feed, row.generation, row.seq));
}

async fn stream_messages(stream: &jetstream::stream::Stream) -> Ordered {
    stream
        .create_consumer(OrderedConfig { deliver_policy: DeliverPolicy::All, ..Default::default() })
        .await
        .unwrap()
        .messages()
        .await
        .unwrap()
}

async fn expect_patch(messages: &mut Ordered, subject: &str, stream_seq: u64, feed_seq: i64) {
    let msg = tokio::time::timeout(Duration::from_secs(10), messages.next())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for patch {feed_seq} on {subject}"))
        .unwrap()
        .unwrap();
    assert_eq!(msg.subject.as_str(), subject);
    assert_eq!(msg.info().unwrap().stream_sequence, stream_seq);
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&msg.payload).unwrap()["seq"], feed_seq);
}

async fn wait_pending(pool: &PgPool, count: usize) -> Vec<store::Pending> {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        let pending = store::pending(pool, count as i64 + 1).await.unwrap();
        if pending.len() == count {
            return pending;
        }
        assert!(Instant::now() < end, "expected {count} pending outbox rows, got {}", pending.len());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn delete_test_stream_and_schema(db: &str, js: &jetstream::Context, stream_name: &str, schema: &str) {
    js.delete_stream(stream_name).await.unwrap();
    let admin = PgPool::connect(db).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&admin).await.unwrap();
}

fn patch_headers(row: &store::Pending) -> async_nats::HeaderMap {
    let mut headers = async_nats::HeaderMap::new();
    headers.insert("Nats-Msg-Id", format!("{}:{}:{}", row.feed, row.generation, row.seq).as_str());
    headers.insert("Feed-Generation", row.generation.as_str());
    headers
}

#[tokio::test]
async fn a_refused_reload_marker_leaves_the_patch_pending_for_retry() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("marker_retry_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    test_items(&pool).await;
    new_feed(&pool, "large").await;
    // Exercise the longest generation and sequence a Corten write can produce.
    sqlx::query("UPDATE corten_feeds SET generation = 'ffffffffffffffff', seq = $1 WHERE key = 'large'")
        .bind(i64::MAX - 1)
        .execute(&pool)
        .await
        .unwrap();
    let nats = async_nats::connect(nats).await.unwrap();
    let js = jetstream::new(nats.clone());
    let stream_name = schema.to_uppercase();
    let subject = format!("{schema}.large");
    let mut config = jetstream::stream::Config {
        name: stream_name.clone(),
        subjects: vec![format!("{schema}.>")],
        max_message_size: 32, // Even the marker's headers won't fit.
        ..Default::default()
    };
    let mut stream = js.create_stream(config.clone()).await.unwrap();
    let mut attempts = nats.subscribe(subject.clone()).await.unwrap();
    let Begin::New(write) = begin(&pool, "large", None).await.unwrap() else { unreachable!() };
    let item = Item { id: "x".repeat(1024), n: 1 };
    write.commit(&[Change::Upsert { id: &item.id, value: &item }]).await.unwrap();
    let pending = wait_pending(&pool, 1).await;
    let options = Options { stream: stream_name.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let _cluster = Cluster::start(pool.clone(), nats, Items, options).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        for _ in 0..2 {
            loop {
                let message = attempts.next().await.unwrap();
                if message.headers.is_some_and(|headers| headers.get("Corten-Reload").is_some()) {
                    let bytes = message.length - message.subject.len() - message.reply.unwrap().len();
                    assert_eq!(bytes, "large".len() + 135);
                    break;
                }
            }
        }
    })
    .await
    .expect("relay did not retry the marker");
    assert_eq!(store::pending(&pool, 10).await.unwrap().len(), 1);
    assert_eq!(stream.info().await.unwrap().state.messages, 0);

    config.max_message_size = ("large".len() + 135) as i32;
    js.update_stream(config.clone()).await.unwrap();
    let mut messages = stream_messages(&stream).await;
    expect_reload(&mut messages, &subject, &pending[0]).await;
    wait_pending(&pool, 0).await;
    assert_eq!(stream.info().await.unwrap().state.messages, 1);

    // After a limit change a retry may send the original patch. JetStream treats it
    // as the same notification because the marker used the patch's deduplication ID.
    config.max_message_size = -1;
    js.update_stream(config).await.unwrap();
    let row = &pending[0];
    let ack = js.publish_with_headers(subject, patch_headers(row), row.body.clone().into()).await.unwrap().await.unwrap();
    assert!(ack.duplicate);
    assert_eq!(stream.info().await.unwrap().state.messages, 1);
    delete_test_stream_and_schema(&db, &js, &stream_name, &schema).await;
}

#[tokio::test]
async fn a_duplicate_marker_ack_retires_an_original_patch_without_claiming_a_marker_was_stored() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let logs = Capture::default();
    let _capture = tracing::subscriber::set_default(logs.clone());
    let schema = key("duplicate_marker_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    test_items(&pool).await;
    new_feed(&pool, "large").await;
    let nats = async_nats::connect(nats).await.unwrap();
    let js = jetstream::new(nats.clone());
    let stream_name = schema.to_uppercase();
    let subject = format!("{schema}.large");
    let mut config = jetstream::stream::Config {
        name: stream_name.clone(),
        subjects: vec![subject.clone()],
        duplicate_window: Duration::from_secs(60),
        ..Default::default()
    };
    let mut stream = js.create_stream(config.clone()).await.unwrap();
    let Begin::New(write) = begin(&pool, "large", None).await.unwrap() else { unreachable!() };
    let item = Item { id: "x".repeat(1024), n: 1 };
    write.commit(&[Change::Upsert { id: &item.id, value: &item }]).await.unwrap();
    let pending = wait_pending(&pool, 1).await;
    let row = &pending[0];

    // Store the original as if a previous relay died before retiring the row.
    let ack = js.publish_with_headers(subject.clone(), patch_headers(row), row.body.clone().into()).await.unwrap().await.unwrap();
    assert!(!ack.duplicate);
    config.max_message_size = 512;
    js.update_stream(config).await.unwrap();
    let options = Options { stream: stream_name.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let _cluster = Cluster::start(pool.clone(), nats, Items, options).await.unwrap();
    wait_pending(&pool, 0).await;
    expect_retirement_log(
        &pool, row, &logs,
        "duplicate reload marker acknowledgement (already accepted notification, kind unknown): JetStream size refusal (10054); patch kept for inspection",
    )
    .await;
    assert!(!logs.0.lock().unwrap().iter().any(|line| line.contains("published reload marker")));
    let mut messages = stream_messages(&stream).await;
    expect_patch(&mut messages, &subject, 1, 1).await;
    assert_eq!(stream.info().await.unwrap().state.messages, 1);
    delete_test_stream_and_schema(&db, &js, &stream_name, &schema).await;
}

#[tokio::test]
async fn an_unacknowledged_marker_does_not_block_other_retirements() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let logs = Capture::default();
    let _capture = tracing::subscriber::set_default(logs.clone());
    let schema = key("marker_ack_timeout_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    test_items(&pool).await;
    sqlx::raw_sql(
        "CREATE TABLE retirements (id bigint);
         CREATE FUNCTION record_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
             INSERT INTO retirements VALUES (NEW.id);
             RETURN NULL;
         END $$;
         CREATE TRIGGER record_retirement AFTER UPDATE OF published_at ON corten_outbox
             FOR EACH ROW EXECUTE FUNCTION record_retirement();",
    )
    .execute(&pool)
    .await
    .unwrap();
    for feed in ["delayed", "ready", "small"] {
        new_feed(&pool, feed).await;
    }
    for feed in ["delayed", "ready"] {
        let Begin::New(write) = begin(&pool, feed, None).await.unwrap() else { unreachable!() };
        let item = Item { id: "x".repeat(LOW_PAYLOAD), n: 1 };
        write.commit(&[Change::Upsert { id: &item.id, value: &item }]).await.unwrap();
    }
    set(&pool, "small", 1, None).await;
    let rows = wait_pending(&pool, 3).await;
    let delayed = &rows[0];

    let observer = async_nats::connect(&nats).await.unwrap();
    let js = jetstream::new(observer);
    let stream = schema.to_uppercase();
    let delayed_subject = format!("{schema}.delayed");
    let mut attempts = js.client().subscribe(delayed_subject.clone()).await.unwrap();
    js.client().flush().await.unwrap();
    let mut config = jetstream::stream::Config {
        name: format!("{stream}_DELAYED"),
        subjects: vec![delayed_subject.clone()],
        // Store the first marker, but suppress its publish ack and those of any retries.
        no_ack: true,
        ..Default::default()
    };
    let mut delayed_stream = js.create_stream(config.clone()).await.unwrap();
    js.create_stream(jetstream::stream::Config {
        name: stream.clone(),
        subjects: vec![format!("{schema}.ready"), format!("{schema}.small")],
        ..Default::default()
    })
    .await
    .unwrap();

    // Refuse the large patches before sending them so only their markers need a broker ack.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let proxy = tokio::spawn(payload_proxy(listener, nats.parse().unwrap(), LOW_PAYLOAD));
    let publisher = async_nats::ConnectOptions::new().ignore_discovered_servers().connect(addr).await.unwrap();
    assert_eq!(publisher.max_payload(), LOW_PAYLOAD);
    let options =
        Options { stream: stream.clone(), subject_prefix: schema.clone(), lease: Duration::from_secs(4), ..Options::default() };
    let sender = relay::Publisher::new(jetstream::new(publisher.clone()));
    let relay = tokio::spawn(relay::run(pool.clone(), sender, Arc::new(options), Arc::default()));

    let mut messages = stream_messages(&delayed_stream).await;
    expect_reload(&mut messages, &delayed_subject, delayed).await;
    let old_reply = tokio::time::timeout(Duration::from_secs(10), attempts.next()).await.unwrap().unwrap().reply.unwrap();
    let pending = wait_pending(&pool, 1).await;
    assert_eq!(pending[0].id, delayed.id);
    let warning = "WARN corten::feed message=reload marker publish failed; outbox row remains pending";
    let fields = format!("id={} feed=\"delayed\" error=deadline has elapsed", delayed.id);
    assert!(logs.0.lock().unwrap().iter().any(|line| line.starts_with(warning) && line.contains(&fields)));
    assert_abandoned_reply_closed(&js.client(), &publisher, old_reply).await;

    // Let a retry's duplicate ack through. No second marker is stored and no row is retired twice.
    config.no_ack = false;
    js.update_stream(config.clone()).await.unwrap();
    wait_pending(&pool, 0).await;
    let retired: Vec<i64> = sqlx::query_scalar("SELECT id FROM retirements ORDER BY id").fetch_all(&pool).await.unwrap();
    assert_eq!(retired, rows.iter().map(|row| row.id).collect::<Vec<_>>());
    assert_eq!(delayed_stream.info().await.unwrap().state.messages, 1);

    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    proxy.abort();
    js.delete_stream(&config.name).await.unwrap();
    delete_test_stream_and_schema(&db, &js, &stream, &schema).await;
}

#[tokio::test]
async fn a_marker_that_does_not_fit_does_not_block_other_batches() {
    assert_a_marker_refusal_does_not_block_other_batches(false).await;
}

#[tokio::test]
async fn a_marker_that_cannot_be_sent_does_not_block_other_batches() {
    assert_a_marker_refusal_does_not_block_other_batches(true).await;
}

async fn assert_a_marker_refusal_does_not_block_other_batches(cached: bool) {
    const LIMIT: i32 = 512;
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let logs = Capture::default();
    let _capture = tracing::subscriber::set_default(logs.clone());
    let schema = key("marker_too_large_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    test_items(&pool).await;
    let long = long_key(700);
    new_feed(&pool, &long).await;
    new_feed(&pool, "small").await;
    let observer = async_nats::connect(&nats).await.unwrap();
    let js = jetstream::new(observer.clone());
    let stream_name = schema.to_uppercase();
    let mut stream = js
        .create_stream(jetstream::stream::Config {
            name: stream_name.clone(),
            subjects: vec![format!("{schema}.>")],
            max_message_size: LIMIT,
            ..Default::default()
        })
        .await
        .unwrap();

    // The first row and its marker exceed the limit because the message ID includes
    // the full feed key. Put enough short-key patches behind it to cross a batch boundary.
    assert_eq!(set(&pool, &long, 1, None).await.seq, Some(1));
    for seq in 1..=256 {
        assert_eq!(set(&pool, "small", seq, None).await.seq, Some(seq as u64));
    }
    let rows = wait_pending(&pool, 257).await;
    let options = Options { stream: stream_name.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let (publisher, proxy) = if cached {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let proxy = tokio::spawn(payload_proxy(listener, nats.parse().unwrap(), LIMIT as usize));
        let publisher = async_nats::ConnectOptions::new().ignore_discovered_servers().connect(addr).await.unwrap();
        assert_eq!(publisher.max_payload(), LIMIT as usize);
        (publisher, Some(proxy))
    } else {
        (observer, None)
    };
    let _cluster = Cluster::start(pool.clone(), publisher, Items, options).await.unwrap();

    let pending = wait_pending(&pool, 1).await;
    assert_eq!(pending[0].id, rows[0].id);
    let row = &pending[0];
    let marker_bytes = long.len() + 65 + 2 * (row.generation.len() + 1);
    let limits = if cached {
        format!("Payload size limit of {LIMIT} exceeded by message size of {marker_bytes}")
    } else {
        format!("stream_max_message_size={LIMIT}")
    };
    let message = "ERROR corten::feed message=reload marker refused for size; outbox row remains pending";
    let fields = format!("id={} feed={long:?} marker_bytes={marker_bytes}", row.id);
    assert!(logs
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|log| { log.starts_with(message) && log.contains(&fields) && log.contains(&limits) }));
    let mut messages = stream_messages(&stream).await;
    let short_subject = format!("{schema}.small");
    for seq in 1..=256 {
        expect_patch(&mut messages, &short_subject, seq, seq as i64).await;
    }
    assert_eq!(stream.info().await.unwrap().state.messages, 256);
    assert_eq!(store::pending(&pool, 2).await.unwrap()[0].id, rows[0].id);
    if let Some(proxy) = proxy {
        proxy.abort();
    }
    delete_test_stream_and_schema(&db, &js, &stream_name, &schema).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_relay_retries_an_acknowledgement_error_that_is_not_a_size_refusal() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("full_stream_");
    let pool = schema_pool(&db, &schema).await;
    migrate(&pool).await.unwrap();
    let nats = async_nats::connect(nats).await.unwrap();
    let js = jetstream::new(nats.clone());
    let stream_name = schema.to_uppercase();
    let mut config = jetstream::stream::Config {
        name: stream_name.clone(),
        subjects: vec![format!("{schema}.>")],
        max_messages: 1,
        discard: jetstream::stream::DiscardPolicy::New,
        ..Default::default()
    };
    let mut stream = js.create_stream(config.clone()).await.unwrap();
    js.publish(format!("{schema}.probe"), "fill".into()).await.unwrap().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(create_feed(&mut tx, "small").await.unwrap());
    tx.commit().await.unwrap();
    let Begin::New(write) = begin(&pool, "small", None).await.unwrap() else { unreachable!() };
    let item = Item { id: "a".into(), n: 1 };
    write.commit(&[Change::Upsert { id: "a", value: &item }]).await.unwrap();

    let mut attempts = nats.subscribe(format!("{schema}.small")).await.unwrap();
    let options = Options { stream: stream_name.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let _cluster = Cluster::start(pool.clone(), nats, Items, options).await.unwrap();
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(10), attempts.next()).await.expect("relay did not retry").unwrap();
    }
    assert_eq!(store::pending(&pool, 10).await.unwrap().len(), 1);
    assert_eq!(stream.info().await.unwrap().state.messages, 1);

    config.max_messages = 2;
    js.update_stream(config).await.unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    while !store::pending(&pool, 10).await.unwrap().is_empty() {
        assert!(Instant::now() < end, "the pending patch was not delivered after the stream limit increased");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(stream.info().await.unwrap().state.messages, 2);
    js.delete_stream(&stream_name).await.unwrap();
    let admin = PgPool::connect(&db).await.unwrap();
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE")).execute(&admin).await.unwrap();
}

#[tokio::test]
async fn a_broker_disconnect_can_reorder_a_feed_but_the_follower_recovers() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    disconnect_and_recover(&db, &nats).await;
}

#[tokio::test]
async fn a_partial_timeout_retries_on_a_broker_with_capped_subscriptions() {
    let (Ok(db), Ok(nats)) = (std::env::var("CORTEN_TEST_DATABASE_URL"), std::env::var("CORTEN_TEST_NATS_CAPPED_URL")) else {
        return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_CAPPED_URL (max_subscriptions: 3)");
    };
    disconnect_and_recover(&db, &nats).await;
}

async fn disconnect_and_recover(db: &str, nats: &str) {
    let schema = key("interrupted_");
    let pool = schema_pool(db, &schema).await;
    migrate(&pool).await.unwrap();
    test_items(&pool).await;
    new_feed(&pool, "feed").await;
    new_feed(&pool, "other").await;
    let options = Arc::new(Options { stream: schema.to_uppercase(), subject_prefix: schema.clone(), ..Options::default() });
    let observer = async_nats::connect(nats).await.unwrap();
    let js = jetstream::new(observer.clone());
    let logs = Capture::default();
    let _capture = tracing::subscriber::set_default(logs.clone());
    let hub = hub::Hub::new(pool.clone(), Items, options.clone());
    hub::start(hub.clone(), js.clone()).await.unwrap();
    let follower = hub.feed("feed").await.unwrap().unwrap();
    let other_follower = hub.feed("other").await.unwrap().unwrap();
    assert_eq!(follower.seq(), 0);

    // The real broker refuses feed patch 2 on a connection with stale-high INFO.
    let oversized = observer.max_payload() + 1;
    let advertised = oversized + 4096;
    set(&pool, "feed", 1, None).await;
    set(&pool, "other", 1, None).await;
    set(&pool, "feed", 2, None).await;
    sqlx::query("UPDATE corten_outbox SET body = body || repeat(' ', $1) WHERE feed = 'feed' AND seq = 2")
        .bind(oversized as i32)
        .execute(&pool)
        .await
        .unwrap();
    set(&pool, "feed", 3, None).await;
    let rows = wait_pending(&pool, 4).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let upstream: async_nats::ServerAddr = nats.parse().unwrap();
    let (reconnecting, replacement) = oneshot::channel();
    let (resume, allow_reconnect) = oneshot::channel();
    let proxy = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.unwrap();
        let mut server = advertise_payload(&mut client, &upstream, advertised).await;
        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
        drop(client);
        let (mut client, _) = listener.accept().await.unwrap();
        reconnecting.send(()).unwrap();
        allow_reconnect.await.unwrap();
        let mut server = TcpStream::connect((upstream.host(), upstream.port())).await.unwrap();
        let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
    });
    let publisher =
        async_nats::ConnectOptions::new().ignore_discovered_servers().subscription_capacity(64).connect(addr).await.unwrap();
    assert_eq!(publisher.max_payload(), advertised);
    let before_refusal = Arc::new(Semaphore::new(0));
    let before_reconnect = Arc::new(Semaphore::new(0));
    let mut sender = relay::Publisher::new(jetstream::new(publisher.clone()));
    sender.pause_before = vec![(rows[2].id, before_refusal.clone()), (rows[3].id, before_reconnect.clone())];
    let mut relay = Box::pin(relay::run(pool.clone(), sender, options.clone(), Arc::default()));
    {
        // Stop polling the relay when the failed attempt enters standby.
        let failed = poll_fn(|cx| {
            assert!(relay.as_mut().poll(cx).is_pending());
            if logs.0.lock().unwrap().iter().any(|line| line.contains("relay standing by")) {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        });
        let failed = tokio::time::timeout(Duration::from_secs(15), failed);
        tokio::pin!(failed);
        tokio::select! {
            result = &mut failed => panic!("relay stopped before reconnect: {result:?}"),
            () = async {
                // Only let patch 2 reach the old socket after the prefix is acknowledged.
                eventually("the acknowledged patch prefix", || {
                    publisher.statistics().in_messages.load(Ordering::Relaxed) == 2
                }).await;
                before_refusal.add_permits(1);
                replacement.await.expect("the client started reconnecting");
            } => {}
        }
        // Poll the relay once with patch 3 unblocked but the new handshake held.
        // It queues patch 3 and begins waiting for this batch's acknowledgements.
        before_reconnect.add_permits(1);
        assert!(tokio::task::unconstrained(failed.as_mut()).now_or_never().is_none());
        resume.send(()).unwrap();
        failed.await.expect("the interrupted attempt failed");
    }
    let pending = store::pending(&pool, 257).await.unwrap();
    let ids = |rows: &[store::Pending]| rows.iter().map(|r| r.id).collect::<Vec<_>>();
    assert_eq!(ids(&pending), ids(&rows), "the failed attempt retires none of the selected rows");

    eventually("the relay connection to be replaced", || publisher.statistics().connects.load(Ordering::Relaxed) == 2).await;
    assert_eq!(publisher.max_payload(), observer.max_payload());
    let mut stream = js.get_stream(&options.stream).await.unwrap();
    let feed_subject = relay::subject(&options, "feed");
    let other_subject = relay::subject(&options, "other");
    let mut messages = stream_messages(&stream).await;
    expect_patch(&mut messages, &feed_subject, 1, 1).await;
    expect_patch(&mut messages, &other_subject, 2, 1).await;
    // Patch 3 reached JetStream on the replacement socket, not from the retry below.
    expect_patch(&mut messages, &feed_subject, 3, 3).await;

    let relay = tokio::spawn(relay);
    wait_pending(&pool, 0).await;
    assert_eq!(stream.info().await.unwrap().state.messages, 4, "no extra messages within the dedup window");
    expect_reload(&mut messages, &feed_subject, &rows[2]).await;
    eventually("the feed to be ready at sequence 3", || hub.stats().iter().any(|(key, seq, _)| key == "feed" && *seq == 3)).await;
    assert_eq!(follower.read(|rows| rows["a"].n), 3);
    assert!(logs.0.lock().unwrap().iter().any(|log| log.contains("gap in the feed's patches: reloading it")));

    // Omit message IDs so JetStream stores the old patch again and both stale markers.
    // This tests follower handling, not expiry of JetStream's deduplication window.
    let mut live =
        corten::http::Body::new(follower.live(Since(Some(corten::feed::Cursor::new(follower.generation(), 3)))).into_body())
            .into_data_stream();
    let opening = live.next().await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&opening).starts_with("retry:"));
    let before = follower.read(Clone::clone);
    let mut headers = async_nats::HeaderMap::new();
    headers.insert("Feed-Generation", rows[0].generation.as_str());
    let duplicate =
        js.publish_with_headers(feed_subject.clone(), headers.clone(), rows[0].body.clone().into()).await.unwrap().await.unwrap();
    assert_eq!(duplicate.sequence, 5);
    assert!(!duplicate.duplicate, "JetStream stored the repeated notification");
    for (seq, stream_seq) in [("2", 6), ("3", 7)] {
        headers.insert(RELOAD_HEADER, seq);
        let stale =
            js.publish_with_headers(feed_subject.clone(), headers.clone(), Default::default()).await.unwrap().await.unwrap();
        assert_eq!(stale.sequence, stream_seq);
        assert!(!stale.duplicate, "JetStream stored the stale marker");
    }

    // The hub's ordered consumer must have handled all three notifications before
    // delivering this patch on the other feed.
    assert_eq!(set(&pool, "other", 2, None).await.seq, Some(2));
    eventually("the other feed to pass the stale notifications", || other_follower.seq() == 2).await;
    assert!(hub.stats().iter().any(|(key, _, _)| key == "feed"), "stale notifications must not start a reload");
    assert_eq!(follower.seq(), 3);
    assert_eq!(follower.read(Clone::clone), before);

    // On the same SSE connection the next frame must be patch 4, not a replay or sync.
    assert_eq!(set(&pool, "feed", 4, None).await.seq, Some(4));
    let frame = tokio::time::timeout(Duration::from_secs(10), live.next()).await.unwrap().unwrap().unwrap();
    let frame = std::str::from_utf8(&frame).unwrap();
    assert!(frame.starts_with(&format!("event: patch\nid: {}-4\ndata: ", follower.generation())), "{frame}");
    assert_eq!(follower.seq(), 4);
    assert_eq!(follower.read(|rows| rows["a"].n), 4);
    wait_pending(&pool, 0).await;

    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    proxy.abort();
    delete_test_stream_and_schema(db, &js, &options.stream, &schema).await;
}

async fn unacknowledged_batch(pool: &PgPool, nats: &str, schema: &str) -> (jetstream::Context, jetstream::stream::Config) {
    migrate(pool).await.unwrap();
    sqlx::query(
        "INSERT INTO corten_outbox (feed, generation, seq, body)
         SELECT 'feed', 'test', n, '{}' FROM generate_series(1, 256) n ORDER BY n",
    )
    .execute(pool)
    .await
    .unwrap();
    let js = jetstream::new(async_nats::connect(nats).await.unwrap());
    let config = jetstream::stream::Config {
        name: schema.to_uppercase(),
        subjects: vec![format!("{schema}.>")],
        no_ack: true,
        duplicate_window: Duration::from_secs(300),
        ..Default::default()
    };
    js.create_stream(config.clone()).await.unwrap();
    (js, config)
}

async fn assert_abandoned_reply_closed(
    observer: &async_nats::Client,
    publisher: &async_nats::Client,
    old_reply: async_nats::Subject,
) {
    let barrier = publisher.new_inbox();
    let mut barrier_replies = publisher.subscribe(barrier.clone()).await.unwrap();
    // A message sent on the subscribing connection proves the broker processed the SUB.
    publisher.publish(barrier.clone(), Default::default()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), barrier_replies.next()).await.unwrap().unwrap();
    let received = publisher.statistics().in_messages.load(Ordering::Relaxed);
    // Both publishes come from the same socket. If the old subscription is still open,
    // its delivery is counted before the barrier reply arrives.
    observer.publish(old_reply, Default::default()).await.unwrap();
    observer.publish(barrier, Default::default()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), barrier_replies.next()).await.unwrap().unwrap();
    assert_eq!(
        publisher.statistics().in_messages.load(Ordering::Relaxed),
        received + 1,
        "the abandoned reply subscription is still open"
    );
}

#[tokio::test]
async fn a_retried_batch_stops_receiving_replies_for_abandoned_attempts() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("abandoned_replies_");
    let pool = schema_pool(&db, &schema).await;
    let (js, mut config) = unacknowledged_batch(&pool, &nats, &schema).await;
    let observer = js.client();
    let mut attempts = observer.subscribe(format!("{schema}.feed")).await.unwrap();
    observer.flush().await.unwrap();
    let publisher = async_nats::ConnectOptions::new().subscription_capacity(256).connect(&nats).await.unwrap();
    let options = Arc::new(Options { stream: config.name.clone(), subject_prefix: schema.clone(), ..Options::default() });
    let sender = relay::Publisher::new(jetstream::new(publisher.clone())).with_timeout(Duration::from_millis(100));
    let relay = tokio::spawn(relay::run(pool.clone(), sender, options, Arc::default()));
    let old_reply = tokio::time::timeout(Duration::from_secs(10), async {
        let reply = attempts.next().await.unwrap().reply.unwrap();
        for _ in 0..255 {
            attempts.next().await.unwrap();
        }
        assert_ne!(attempts.next().await.unwrap().reply.as_ref(), Some(&reply));
        reply
    })
    .await
    .expect("the relay sent a batch and retried");
    assert_eq!(store::pending(&pool, 257).await.unwrap().len(), 256);
    assert_abandoned_reply_closed(&observer, &publisher, old_reply).await;

    config.no_ack = false;
    js.update_stream(config.clone()).await.unwrap();
    wait_pending(&pool, 0).await;
    assert_eq!(
        js.get_stream(&config.name).await.unwrap().cached_info().state.messages,
        256,
        "only one copy of each stored patch"
    );
    assert_eq!(publisher.statistics().connects.load(Ordering::Relaxed), 1);
    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    delete_test_stream_and_schema(&db, &js, &config.name, &schema).await;
}

#[tokio::test]
async fn a_full_batch_retires_with_a_small_reply_queue() {
    full_batch_with_reply_capacity(64).await;
}

#[tokio::test]
async fn a_full_batch_retires_with_a_one_reply_queue() {
    full_batch_with_reply_capacity(1).await;
}

async fn full_batch_with_reply_capacity(capacity: usize) {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("small_reply_queue_");
    let pool = schema_pool(&db, &schema).await;
    let (js, mut config) = unacknowledged_batch(&pool, &nats, &schema).await;
    config.no_ack = false;
    js.update_stream(config.clone()).await.unwrap();

    let publisher = async_nats::ConnectOptions::new().subscription_capacity(capacity).connect(&nats).await.unwrap();
    let stats = publisher.statistics();
    let mut sender = relay::Publisher::new(jetstream::new(publisher)).with_timeout(Duration::from_secs(1));
    let gate = Arc::new(Semaphore::new(0));
    let rows = store::pending(&pool, 257).await.unwrap();
    assert_eq!(rows.len(), 256);
    sender.pause_before.push((rows[128].id, gate.clone()));
    let options = Arc::new(Options { stream: config.name.clone(), subject_prefix: schema.clone(), ..Options::default() });
    let relay = tokio::spawn(relay::run(pool.clone(), sender, options, Arc::default()));

    // Let more replies than the queue can hold reach the client before sends can proceed.
    eventually("the first 128 publish replies reached the client", || stats.in_messages.load(Ordering::Relaxed) == 128).await;
    gate.add_permits(1);
    wait_pending(&pool, 0).await;
    let publishes = stats.out_messages.load(Ordering::Relaxed);
    assert!(matches!(publishes, 256 | 512), "all rows retired with at most one retry: {publishes} publishes");
    assert_eq!(js.get_stream(&config.name).await.unwrap().cached_info().state.messages, 256);
    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    delete_test_stream_and_schema(&db, &js, &config.name, &schema).await;
}

#[tokio::test]
async fn a_slow_single_reply_batch_retires_in_fresh_lease_passes() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("slow_single_reply_");
    let pool = schema_pool(&db, &schema).await;
    let (js, mut config) = unacknowledged_batch(&pool, &nats, &schema).await;
    config.no_ack = false;
    config.max_message_size = 512;
    js.update_stream(config.clone()).await.unwrap();
    sqlx::query("UPDATE corten_outbox SET body = repeat(' ', 1024) WHERE seq = 2").execute(&pool).await.unwrap();

    let observer = js.client();
    let mut publishes = observer.subscribe(format!("{schema}.feed")).await.unwrap();
    observer.flush().await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let upstream: async_nats::ServerAddr = nats.parse().unwrap();
    let proxy = tokio::spawn(async move {
        let (mut client, _) = listener.accept().await.unwrap();
        let mut server = TcpStream::connect((upstream.host(), upstream.port())).await.unwrap();
        let (mut client_read, mut client_write) = client.split();
        let (mut server_read, mut server_write) = server.split();
        tokio::select! {
            _ = tokio::io::copy(&mut client_read, &mut server_write) => {}
            () = async {
                let mut buf = [0; 8192];
                loop {
                    let n = server_read.read(&mut buf).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    client_write.write_all(&buf[..n]).await.unwrap();
                }
            } => {}
        }
    });
    let publisher = async_nats::ConnectOptions::new().subscription_capacity(1).connect(addr).await.unwrap();
    // Start in the fallback so this check does not depend on when the client drops replies.
    let sender = relay::Publisher::new(jetstream::new(publisher)).with_single_reply();
    let options = Arc::new(Options { stream: config.name.clone(), subject_prefix: schema.clone(), ..Options::default() });
    let mut contender = pool.acquire().await.unwrap().detach();
    let relay = tokio::spawn(relay::run(pool.clone(), sender, options.clone(), Arc::default()));
    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(25), async {
        // There is one extra publish for the size-refused row's reload marker.
        for n in 1..=257 {
            publishes.next().await.unwrap();
            assert!(!store::lease(&mut contender, "contender", options.lease).await.unwrap(), "lease lost by publish {n}");
            if n == 128 {
                let pending = store::pending(&pool, 257).await.unwrap();
                assert!(!pending.is_empty() && pending.len() < 256, "the acknowledged prefix must retire before the tail");
                assert!(pending.iter().all(|row| row.seq != 2), "the size-refused row's marker must retire too");
            }
        }
    })
    .await
    .expect("the delayed batch kept publishing");
    assert!(started.elapsed() > options.lease, "the fixture must outlast the original lease");
    wait_pending(&pool, 0).await;
    assert_eq!(js.get_stream(&config.name).await.unwrap().cached_info().state.messages, 256);
    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    proxy.abort();
    if let Err(error) = proxy.await {
        assert!(error.is_cancelled(), "{error}");
    }
    delete_test_stream_and_schema(&db, &js, &config.name, &schema).await;
}

#[tokio::test]
async fn a_stalled_single_reply_send_leaves_only_unacknowledged_rows_pending() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("stalled_single_reply_");
    let pool = schema_pool(&db, &schema).await;
    let (js, mut config) = unacknowledged_batch(&pool, &nats, &schema).await;
    config.no_ack = false;
    js.update_stream(config.clone()).await.unwrap();

    let publisher = async_nats::ConnectOptions::new().subscription_capacity(1).connect(&nats).await.unwrap();
    let stats = publisher.statistics();
    let mut sender = relay::Publisher::new(jetstream::new(publisher)).with_single_reply();
    let gate = Arc::new(Semaphore::new(0));
    let rows = store::pending(&pool, 257).await.unwrap();
    sender.pause_before.push((rows[3].id, gate.clone()));
    let options = Arc::new(Options { stream: config.name.clone(), subject_prefix: schema.clone(), ..Options::default() });
    let relay = tokio::spawn(relay::run(pool.clone(), sender, options, Arc::default()));
    let pending = wait_pending(&pool, 253).await;
    assert_eq!(pending[0].seq, 4, "the acknowledged prefix retired even though the next send stalled");
    assert_eq!(stats.out_messages.load(Ordering::Relaxed), 3, "the stalled send did not enqueue a publish");
    gate.add_permits(1);
    wait_pending(&pool, 0).await;
    assert_eq!(stats.out_messages.load(Ordering::Relaxed), 256, "later passes sent only the remaining rows");
    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    delete_test_stream_and_schema(&db, &js, &config.name, &schema).await;
}

/// Run in release mode with the cluster test URLs to sample relay-process RSS, not broker RSS.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore]
async fn relay_missing_ack_rss() {
    let (db, nats) = urls().expect("set the cluster integration URLs");
    let schema = key("ack_rss_");
    let pool = schema_pool(&db, &schema).await;
    let (js, config) = unacknowledged_batch(&pool, &nats, &schema).await;
    let publisher = async_nats::connect(&nats).await.unwrap();
    let stats = publisher.statistics();
    let options = Arc::new(Options {
        stream: config.name.clone(),
        subject_prefix: schema.clone(),
        lease: Duration::from_millis(100),
        ..Options::default()
    });
    let sender = relay::Publisher::new(jetstream::new(publisher)).with_timeout(Duration::from_millis(5));
    let relay = tokio::spawn(relay::run(pool.clone(), sender, options, Arc::default()));
    for batches in [10, 250, 500, 1000] {
        tokio::time::timeout(Duration::from_secs(100), async {
            while stats.out_messages.load(Ordering::Relaxed) < batches * 256 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("retry target reached");
        let rss = std::fs::read_to_string("/proc/self/status").unwrap();
        let rss = rss.lines().find(|line| line.starts_with("VmRSS:")).unwrap();
        println!("{batches} batches ({} publishes): {rss}", stats.out_messages.load(Ordering::Relaxed));
    }
    assert_eq!(stats.in_messages.load(Ordering::Relaxed), 0);
    assert_eq!(stats.connects.load(Ordering::Relaxed), 1);
    assert_eq!(store::pending(&pool, 257).await.unwrap().len(), 256);
    assert_eq!(js.get_stream(&config.name).await.unwrap().cached_info().state.messages, 256);
    relay.abort();
    assert!(relay.await.unwrap_err().is_cancelled());
    delete_test_stream_and_schema(&db, &js, &config.name, &schema).await;
}

/// Healthy relay throughput, with startup but not setup timed. Alternate release binaries on
/// the same Postgres and NATS, ignoring the first sample per binary. Each sample starts with a
/// fresh schema and stream. Run alone: `cargo test --release -p corten-cluster -- --ignored
/// --nocapture relay_throughput`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn relay_throughput() {
    const ROWS: i64 = 16_384;
    let (db, nats) = urls().expect("set the cluster integration URLs");
    let js = jetstream::new(async_nats::connect(nats).await.unwrap());
    for feeds in [256_i64, 16, 1] {
        let schema = key("throughput_");
        let pool = schema_pool(&db, &schema).await;
        migrate(&pool).await.unwrap();
        sqlx::query("INSERT INTO corten_outbox (feed, generation, seq, body)
                     SELECT 'f' || (g % $1), 'test', (g / $1) + 1, json_build_object('seq', (g / $1) + 1, 'changes', '[]'::json)::text
                     FROM generate_series(0, $2::bigint - 1) g ORDER BY g")
            .bind(feeds)
            .bind(ROWS)
            .execute(&pool)
            .await
            .unwrap();
        let options = Arc::new(Options { stream: schema.to_uppercase(), subject_prefix: schema.clone(), ..Options::default() });
        let mut stream = js
            .create_stream(jetstream::stream::Config {
                name: options.stream.clone(),
                subjects: vec![format!("{schema}.>")],
                ..Default::default()
            })
            .await
            .unwrap();
        let started = Instant::now();
        let relay = tokio::spawn(relay::run(pool.clone(), relay::Publisher::new(js.clone()), options.clone(), Arc::default()));
        tokio::time::timeout(Duration::from_secs(60), async {
            while !store::pending(&pool, 1).await.unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        println!("{feeds} feeds: {:.0} rows/s", ROWS as f64 / started.elapsed().as_secs_f64());
        assert_eq!(stream.info().await.unwrap().state.messages, ROWS as u64);
        relay.abort();
        assert!(relay.await.unwrap_err().is_cancelled());
        delete_test_stream_and_schema(&db, &js, &options.stream, &schema).await;
    }
}

/// One write's latency until a follower has it (begin, statements, commit, relay, JetStream,
/// hub) over real Postgres and NATS. Run in release mode, alone, with the integration URLs set;
/// alternate the builds being compared on the same services.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn relay_latency() {
    let (db, nats) = urls().expect("set the cluster integration URLs");
    let pool = pool(&db).await;
    let feed = key("latency");
    new_feed(&pool, &feed).await;
    let cluster =
        Cluster::start(pool.clone(), async_nats::connect(&nats).await.unwrap(), Items, Options::default()).await.unwrap();
    let followed = cluster.feed(&feed).await.unwrap().unwrap();
    let mut samples = Vec::new();
    for n in 1..=110 {
        let started = Instant::now();
        set(&pool, &feed, n, None).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            while followed.seq() < n as u64 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if n > 10 {
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "110 serial writes, 10 warmup: write to follower ms median={:.3}, p95={:.3}, range={:.3}..{:.3}",
        samples[50], samples[94], samples[0], samples[99]
    );
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
async fn an_idempotency_key_used_on_one_feed_is_refused_on_another() {
    let Some((db, _)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let pool = pool(&db).await;
    let (a, b) = (key("idema"), key("idemb"));
    new_feed(&pool, &a).await;
    new_feed(&pool, &b).await;
    // A client's key names no feed.
    let idem = key("intent");
    let first = set(&pool, &a, 1, Some(&idem)).await;
    assert_eq!((first.seq, first.replayed), (Some(1), false));
    match begin(&pool, &b, Some(&idem)).await {
        Err(error) => {
            assert!(error.is::<IdempotencyKeyReused>(), "{error}");
            assert!(!error.to_string().contains(&a), "the refusal names the other feed: {error}");
        }
        Ok(Begin::Done(written)) => panic!("the write to {b} was answered with {a}'s: {written:?}"),
        Ok(Begin::New(_)) => panic!("a write to {b} began with a key {a} already used"),
    }
    assert_eq!(seq(&pool, &b).await.unwrap(), Some(0), "nothing was written to {b}");
    let outbox: i64 =
        sqlx::query_scalar("SELECT count(*) FROM corten_outbox WHERE feed = $1").bind(&b).fetch_one(&pool).await.unwrap();
    assert_eq!(outbox, 0);
    let retry = set(&pool, &a, 99, Some(&idem)).await;
    assert_eq!((retry.seq, retry.replayed), (Some(1), true), "a repeat on {a} is still its replay");
    assert_eq!(seq(&pool, &a).await.unwrap(), Some(1));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cluster_client_with_a_root_ca_requires_tls() {
    let Ok(tls) = std::env::var("CORTEN_TEST_NATS_TLS_URL") else {
        return eprintln!("skipped: set CORTEN_TEST_NATS_TLS_URL and CORTEN_TEST_NATS_CA_FILE for a TLS JetStream broker");
    };
    let (db, plain) = urls().expect("set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL (a plaintext broker)");
    let ca = std::env::var_os("CORTEN_TEST_NATS_CA_FILE").expect("set CORTEN_TEST_NATS_CA_FILE to the broker's CA PEM");
    let options = async_nats::ConnectOptions::new().add_root_certificates(ca.into());
    let error = options.clone().connect(&plain).await.expect_err("the client accepted plaintext with a CA configured");
    assert_eq!(error.kind(), async_nats::ConnectErrorKind::Tls);

    let nats = options.connect(&tls).await.unwrap();
    let schema = key("tls_");
    let pool = schema_pool(&db, &schema).await;
    test_items(&pool).await;
    let stream = schema.to_uppercase();
    let options = Options { stream: stream.clone(), subject_prefix: schema.clone(), ..Options::default() };
    let cluster = Cluster::start(pool.clone(), nats.clone(), Items, options).await.unwrap();
    let feed = "secured";
    new_feed(&pool, feed).await;
    let followed = cluster.feed(feed).await.unwrap().unwrap();
    assert_eq!(set(&pool, feed, 1, None).await.seq, Some(1));
    eventually("the follower to receive the patch over TLS", || followed.seq() == 1).await;
    assert_eq!(followed.read(|rows| rows["a"].n), 1);
    wait_pending(&pool, 0).await;
    delete_test_stream_and_schema(&db, &jetstream::new(nats), &stream, &schema).await;
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
    let body = corten::http::Body::new(fc.live(cursor).into_body());
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
    let body = corten::http::Body::new(again.live(Since(Some(corten::feed::Cursor::new(&generation, 1)))).into_body());
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
    let mut live = corten::http::Body::new(
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
    // A key no feed can have is not found either, rather than the service being unavailable.
    let (status, kind, body) = get("bad..key").await;
    assert_eq!((status, kind.as_str()), (StatusCode::NOT_FOUND, "application/problem+json"));
    assert!(body.contains(r#""status":404"#), "{body}");
}
