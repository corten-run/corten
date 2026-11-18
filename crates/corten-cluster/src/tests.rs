//! Integration tests against real Postgres and NATS (JetStream). They run when
//! `CORTEN_TEST_DATABASE_URL` and `CORTEN_TEST_NATS_URL` are set and are skipped otherwise; see
//! CONTRIBUTING.md for the containers. Each test uses its own feed keys, so they can share a database,
//! but the relay lease is one row, so run them with `--test-threads=1`.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use async_nats::jetstream::{
    self,
    consumer::{
        pull::{Ordered, OrderedConfig},
        DeliverPolicy,
    },
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
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

    delete_test_stream_and_schema(&db, &js, &stream_name, &schema).await;
}

const LOW_PAYLOAD: usize = 4096;

/// Relay one connection to the real broker, substituting a stale-low initial INFO.
async fn payload_proxy(listener: TcpListener, upstream: async_nats::ServerAddr) {
    let (mut client, _) = listener.accept().await.unwrap();
    let mut server = BufReader::new(TcpStream::connect((upstream.host(), upstream.port())).await.unwrap());
    let mut info = String::new();
    server.read_line(&mut info).await.unwrap();
    let mut advertised: serde_json::Value = serde_json::from_str(info.strip_prefix("INFO ").unwrap()).unwrap();
    advertised["max_payload"] = LOW_PAYLOAD.into();
    client.write_all(format!("INFO {advertised}\r\n").as_bytes()).await.unwrap();
    tokio::io::copy_bidirectional(&mut client, &mut server).await.unwrap();
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
    let proxy = tokio::spawn(payload_proxy(listener, nats.parse().unwrap()));
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
    let (body, done): (String, bool) = sqlx::query_as("SELECT body, published_at IS NOT NULL FROM corten_outbox WHERE id = $1")
        .bind(row.id)
        .fetch_one(pool)
        .await
        .expect("the set-aside row is still in Postgres");
    assert!(done);
    assert_eq!(body, row.body);
    let message = format!("ERROR corten::feed message=published reload marker: {reason}; patch kept for inspection");
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

#[tokio::test]
async fn a_refused_reload_marker_leaves_the_patch_pending_for_retry() {
    let Some((db, nats)) = urls() else { return eprintln!("skipped: set CORTEN_TEST_DATABASE_URL and CORTEN_TEST_NATS_URL") };
    let schema = key("marker_retry_");
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
                if attempts.next().await.unwrap().headers.is_some_and(|headers| headers.get("Corten-Reload").is_some()) {
                    break;
                }
            }
        }
    })
    .await
    .expect("relay did not retry the marker");
    assert_eq!(store::pending(&pool, 10).await.unwrap().len(), 1);
    assert_eq!(stream.info().await.unwrap().state.messages, 0);

    config.max_message_size = 512;
    js.update_stream(config.clone()).await.unwrap();
    let mut messages = stream_messages(&stream).await;
    expect_reload(&mut messages, &subject, &pending[0]).await;
    wait_pending(&pool, 0).await;
    assert_eq!(stream.info().await.unwrap().state.messages, 1);

    // After a limit change a retry may send the original patch. JetStream treats it
    // as the same notification because the marker used the patch's deduplication ID.
    config.max_message_size = -1;
    js.update_stream(config).await.unwrap();
    let mut headers = async_nats::HeaderMap::new();
    let row = &pending[0];
    headers.insert("Nats-Msg-Id", format!("{}:{}:{}", row.feed, row.generation, row.seq).as_str());
    headers.insert("Feed-Generation", row.generation.as_str());
    let ack = js.publish_with_headers(subject, headers, row.body.clone().into()).await.unwrap().await.unwrap();
    assert!(ack.duplicate);
    assert_eq!(stream.info().await.unwrap().state.messages, 1);
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
