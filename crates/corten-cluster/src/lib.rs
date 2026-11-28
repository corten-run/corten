//! One [`corten::feed::Feed`] served by every instance of an app.
//!
//! ```text
//! write ──► Postgres: app rows + corten_feeds.seq + corten_outbox row, one transaction
//!                        │ (NOTIFY at commit)
//!                        ▼
//!           relay (one instance at a time, by lease) ──► NATS JetStream, deduplicated by message id
//!                                                            │
//!           every instance: Hub ◄────────────────────────────┘ applies patches to its Feed
//!                                └──► SSE clients, who resume on any instance with the same cursor
//! ```
//!
//! A patch exists if and only if its write committed (the outbox row is in the same transaction).
//! The relay sends outbox rows in order within each feed and retires them after JetStream acknowledges them.
//! A broker disconnect mid-batch can let queued publishes overtake a failed one. A relay that dies before
//! retiring a row republishes it, and JetStream drops the copy within its deduplication window. Rows with invalid
//! keys are logged and set aside. For a per-publish size refusal the relay sends a reload marker in
//! place of the patch and retires the row only after acknowledgement. The cluster never forces a reconnect.
//! A marker, gap or consumer restart reloads the feed from Postgres. Measured with two instances, kills
//! on a schedule and 200 clients: see `examples/listings-feed` and its `results/`.
//!
//! The app provides its rows through [`Source`] and writes through [`begin`] / [`Write::commit`],
//! with an optional idempotency key so a retried request commits once.
//!
//! The integration tests run against PostgreSQL 19 and NATS JetStream.
//! The crate uses async-nats 0.53 and SQLx 0.8 on Rust 1.89; [design Choice 51](https://github.com/corten-run/corten/blob/main/docs/design.md#choice-msrv)
//! says why and when they move.

mod hub;
mod relay;
mod store;

use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use corten::{
    feed::{Feed, FeedResponse, Row, Since},
    http::StatusCode,
};
use serde::de::DeserializeOwned;
use sqlx::{PgConnection, PgPool};

pub use store::{begin, create_feed, migrate, prune, seq, Begin, Write, Written};

pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// An empty JetStream message carrying the refused patch's feed sequence in this header.
const RELOAD_HEADER: &str = "Corten-Reload";

/// The longest feed key, in bytes. Leaves room for the prefix, reply inbox and publish framing
/// in NATS's default 4 KB control line, and fits Postgres's B-tree indexes without compression
/// on standard 8 KB pages.
pub const MAX_FEED_KEY_BYTES: usize = 1024;

/// The longest [`Options::subject_prefix`], in bytes.
const MAX_PREFIX_BYTES: usize = 255;

/// Reserve for `HPUB`, separators, two decimal lengths (up to 20 digits each), CRLF and
/// a reply slot suffix of up to four bytes (`.255`).
const PUBLISH_FRAMING_BYTES: usize = 64;
const MAX_PUBLISH_SUBJECT_BYTES: usize = MAX_PREFIX_BYTES + 1 + MAX_FEED_KEY_BYTES;

/// A feed key that breaks Corten's literal subject rules, refused by [`create_feed`] and [`begin`]
/// before they touch the database. A key is published as `{subject_prefix}.{key}`, so it must
/// be nonempty dot-separated tokens without whitespace, control characters (NUL included),
/// `*` or `>`, and at most [`MAX_FEED_KEY_BYTES`] long. It arrives inside [`Error`]: test for
/// it with `error.is::<InvalidFeedKey>()`.
///
/// ```
/// # async fn run(pool: sqlx::PgPool) -> Result<(), corten_cluster::Error> {
/// let mut tx = pool.begin().await?;
/// let error = corten_cluster::create_feed(&mut tx, "my feed").await.unwrap_err();
/// assert!(error.is::<corten_cluster::InvalidFeedKey>());
/// assert!(corten_cluster::create_feed(&mut tx, "sellers.42").await?);
/// # Ok(()) }
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidFeedKey;

impl std::fmt::Display for InvalidFeedKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "corten-cluster: a feed key must use nonempty dot-separated tokens \
             without whitespace, control characters, `*` or `>`, at most {MAX_FEED_KEY_BYTES} bytes"
        )
    }
}

impl std::error::Error for InvalidFeedKey {}

/// An idempotency key that already belongs to a write to another feed, refused by [`begin`]: the
/// write is not made and is not answered as a replay. A key's scope is the whole cluster store,
/// so a key two scopes could both send (two tools, two callers) needs the app to make it unique,
/// for example by prefixing it. Answer it as a refusal, a 422 or 409, not a replay or a 503. It
/// does not say which feed holds the key. It arrives inside [`Error`]: test for it with
/// `error.is::<IdempotencyKeyReused>()`.
///
/// ```
/// use corten_cluster::{Begin, IdempotencyKeyReused, Write, Written};
///
/// /// How a write to seller 42 under the client's `key` starts.
/// enum Started {
///     /// Make the change on `write.conn()`, then `write.commit(..)`.
///     New(Write),
///     /// This key's write committed before: answer with what it wrote.
///     Replayed(Written),
///     /// Another feed's write already used this key; nothing was written. Answer a 422.
///     Refused,
/// }
///
/// async fn start(pool: &sqlx::PgPool, key: &str) -> Result<Started, corten_cluster::Error> {
///     let begun = match corten_cluster::begin(pool, "sellers.42", Some(key)).await {
///         Err(error) if error.is::<IdempotencyKeyReused>() => return Ok(Started::Refused),
///         // Any other error (Postgres out of reach) is the app's failure, not the client's.
///         begun => begun?,
///     };
///     Ok(match begun {
///         Begin::New(write) => Started::New(write),
///         Begin::Done(written) => Started::Replayed(written),
///     })
/// }
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IdempotencyKeyReused;

impl std::fmt::Display for IdempotencyKeyReused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "corten-cluster: this idempotency key was already used for a write to another feed")
    }
}

impl std::error::Error for IdempotencyKeyReused {}

/// Corten's literal subject policy follows the documented token and wildcard rules, also
/// excluding control characters (Postgres cannot store NUL) and bounding the byte length.
fn literal(name: &str, max: usize) -> bool {
    name.len() <= max
        && name.split('.').all(|token| {
            !token.is_empty() && !token.chars().any(|c| matches!(c, '*' | '>') || c.is_whitespace() || c.is_control())
        })
}

pub(crate) fn valid_key(key: &str) -> bool {
    literal(key, MAX_FEED_KEY_BYTES)
}

pub(crate) fn check_key(key: &str) -> Result<(), Error> {
    if valid_key(key) {
        Ok(())
    } else {
        Err(InvalidFeedKey.into())
    }
}

/// Where a feed's rows live. Called inside the cluster's consistent read, so the rows match the
/// sequence number and replay log loaded with them.
pub trait Source: Send + Sync + 'static {
    type Row: Row + DeserializeOwned;

    /// Every row of feed `key`.
    fn rows(&self, conn: &mut PgConnection, key: &str) -> impl Future<Output = Result<Vec<Self::Row>, Error>> + Send;
}

/// Settings shared by every instance of an app (except `instance`).
#[derive(Clone, Debug)]
pub struct Options {
    /// Names this instance in logs and in the relay lease.
    pub instance: String,
    /// JetStream stream that carries the patches.
    pub stream: String,
    /// Feed `k` is published on `{subject_prefix}.k`. A literal NATS subject, as a feed key is
    /// ([`InvalidFeedKey`]), of at most 255 bytes; [`Cluster::start`] refuses any other.
    pub subject_prefix: String,
    /// The NATS servers' `max_control_line`, in bytes. Defaults to 4,096 because the server
    /// does not advertise this limit. With the default, a custom inbox prefix may use at most
    /// 2,729 bytes. To use a longer prefix, raise the limit on all NATS servers this client can
    /// connect to and set this field to match.
    pub max_control_line: usize,
    /// The relay lease. The active relay renews it every quarter and steps down if it cannot
    /// renew within three quarters, so after an instance dies another takes over within about
    /// `lease`, even when its connections never close (a frozen VM, a network partition).
    pub lease: Duration,
    /// How long JetStream keeps patches. Followers only need the ones since they loaded.
    pub max_age: Duration,
    /// JetStream drops a republished patch within this window.
    pub duplicate_window: Duration,
    /// A loaded feed with no live stream and no read for this long is dropped from memory and
    /// loaded again on its next request. `None` keeps every feed loaded (a fixed, small set).
    pub idle_unload: Option<Duration>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            instance: "corten".into(),
            stream: "CORTEN_FEEDS".into(),
            subject_prefix: "corten.feeds".into(),
            max_control_line: 4096,
            lease: Duration::from_secs(2),
            max_age: Duration::from_secs(3600),
            duplicate_window: Duration::from_secs(120),
            idle_unload: Some(Duration::from_secs(600)),
        }
    }
}

/// This instance's view of the cluster: the feeds it serves and whether it runs the relay.
pub struct Cluster<S: Source> {
    hub: Arc<hub::Hub<S>>,
    relay_active: Arc<AtomicBool>,
}

impl<S: Source> Clone for Cluster<S> {
    fn clone(&self) -> Self {
        Cluster { hub: self.hub.clone(), relay_active: self.relay_active.clone() }
    }
}

impl<S: Source> Cluster<S> {
    /// Creates the tables if needed, starts this instance's JetStream consumer (before any feed
    /// loads, so no patch falls between a load and the stream) and its relay candidate.
    /// Refuses an invalid subject prefix or a reply inbox that exceeds [`Options::max_control_line`]'s
    /// budget before touching Postgres.
    pub async fn start(pool: PgPool, nats: async_nats::Client, source: S, options: Options) -> Result<Self, Error> {
        if !literal(&options.subject_prefix, MAX_PREFIX_BYTES) {
            return Err(format!(
                "corten-cluster: subject_prefix {:?} is not a literal NATS subject: nonempty dot-separated \
                 tokens without whitespace, control characters, `*` or `>`, at most {MAX_PREFIX_BYTES} bytes",
                options.subject_prefix
            )
            .into());
        }
        // Measure the base inbox the client generates; the framing reserve covers the relay's reply slot.
        let inbox_bytes = nats.new_inbox().len();
        let max_inbox = options.max_control_line.saturating_sub(MAX_PUBLISH_SUBJECT_BYTES + PUBLISH_FRAMING_BYTES);
        if inbox_bytes > max_inbox {
            return Err(format!(
                "corten-cluster: NATS reply inbox uses {inbox_bytes} bytes, but max_control_line={} \
                 allows at most {max_inbox} bytes for the full reply inbox; shorten the custom inbox prefix \
                 or raise both NATS and Options::max_control_line",
                options.max_control_line
            )
            .into());
        }
        store::migrate(&pool).await?;
        let js = async_nats::jetstream::new(nats);
        let options = Arc::new(options);
        let hub = hub::Hub::new(pool.clone(), source, options.clone());
        hub::start(hub.clone(), js.clone()).await?;
        if let Some(after) = options.idle_unload {
            tokio::spawn(hub::unload_idle(hub.clone(), after));
        }
        let relay_active = Arc::new(AtomicBool::new(false));
        tokio::spawn(relay::run(pool, relay::Publisher::new(js), options, relay_active.clone()));
        Ok(Cluster { hub, relay_active })
    }

    /// The feed for `key`, loaded on first use. `None` when no such feed exists. Ask again per
    /// request rather than keeping the handle: an idle feed is unloaded (`Options::idle_unload`),
    /// and a kept handle would stop receiving patches. A key that breaks Corten's subject rules
    /// ([`InvalidFeedKey`]) is `None` without a query: no feed can be written under it.
    pub async fn feed(&self, key: &str) -> Result<Option<Feed<S::Row>>, Error> {
        self.hub.feed(key).await
    }

    /// `GET {url}`: [`Feed::snapshot`], an answer a Corten route names
    /// (`async fn listings(..) -> corten::Result<FeedResponse<Listing>>`). An unknown feed is a 404, and
    /// Postgres out of reach a 503, answered as JSON as any failure of a feed's route is. An app
    /// that answers those its own way calls [`Cluster::feed`] and the feed's `snapshot` instead.
    pub async fn snapshot(&self, key: &str) -> corten::Result<FeedResponse<S::Row>> {
        Ok(self.loaded(key).await?.snapshot())
    }

    /// `GET {url}/live`: [`Feed::live`], with the same errors as [`Cluster::snapshot`].
    pub async fn live(&self, key: &str, since: Since) -> corten::Result<FeedResponse<S::Row>> {
        self.live_with(key, since, ()).await
    }

    /// [`Cluster::live`] holding `guard` (a `corten::feed::Permit`) until the stream ends.
    pub async fn live_with(&self, key: &str, since: Since, guard: impl Send + 'static) -> corten::Result<FeedResponse<S::Row>> {
        Ok(self.loaded(key).await?.live_with(since, guard))
    }

    /// The feed for `key`, or the error its route answers: 404 for none, 503 when it cannot load.
    async fn loaded(&self, key: &str) -> corten::Result<Feed<S::Row>> {
        match self.feed(key).await {
            Ok(Some(feed)) => Ok(feed),
            Ok(None) => Err(corten::Error::new(format!("no feed {key}")).with_status(StatusCode::NOT_FOUND)),
            Err(source) => {
                Err(corten::Error::new(Unavailable { key: key.into(), source }).with_status(StatusCode::SERVICE_UNAVAILABLE))
            }
        }
    }

    /// True while this instance holds the relay lease.
    pub fn relay_active(&self) -> bool {
        self.relay_active.load(Ordering::Relaxed)
    }

    /// Loaded feeds: key, sequence, live subscribers.
    pub fn stats(&self) -> Vec<(String, u64, usize)> {
        self.hub.stats()
    }
}

/// A feed that could not load: its key, and the cause as its source. Its message names the cause
/// too, for the development error page, which shows a failure's message alone; the log line
/// names it again under `error.sources`.
#[derive(Debug)]
struct Unavailable {
    key: String,
    source: Error,
}

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "corten-cluster: feed {}: {}", self.key, self.source)
    }
}

impl std::error::Error for Unavailable {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.source)
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests;
