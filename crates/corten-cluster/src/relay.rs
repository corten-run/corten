//! Outbox relay: publishes committed patches to JetStream in order within each feed. Every instance runs a
//! candidate; the one holding the lease (store::lease) publishes. A valid patch is marked done
//! only after JetStream acknowledged it. A relay that dies or loses its lease in between leaves it to
//! the next one, which publishes it again, and JetStream drops the copy by its message id. Two
//! relays briefly overlapping can republish these rows within the deduplication window.
//!
//! Rows with invalid feed keys or JetStream size refusals are logged and marked done without
//! delivery. A local payload refusal holds only that feed; other failures still retry.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_nats::{
    jetstream::{
        self,
        context::{PublishAckFuture, PublishError, PublishErrorKind},
    },
    HeaderMap,
};
use sqlx::{postgres::PgListener, PgConnection, PgPool};

use crate::{store, valid_key, Error, Options};

/// Outbox rows published per round trip.
pub(super) const BATCH: i64 = 256;
const PAYLOAD_BACKOFF: Duration = Duration::from_secs(5);

pub(crate) fn subject(options: &Options, feed: &str) -> String {
    format!("{}.{feed}", options.subject_prefix)
}

/// Runs forever: wait for the lease, publish while holding it, then start over.
pub(crate) async fn run(pool: PgPool, js: jetstream::Context, options: Arc<Options>, active: Arc<AtomicBool>) {
    let mut held_feeds = HashMap::new();
    loop {
        if let Err(e) = lead(&pool, &js, &options, &active, &mut held_feeds).await {
            let error: &(dyn std::error::Error + 'static) = &*e;
            tracing::warn!(target: "corten::feed", instance = %options.instance, error, "relay standing by");
        }
        active.store(false, Ordering::Relaxed);
        tokio::time::sleep(options.lease / 4).await;
    }
}

/// The lease as held: renewed at `renewed`, which must stay within `stale` to keep publishing.
struct Held {
    conn: PgConnection,
    renewed: Instant,
    stale: Duration,
}

impl Held {
    /// Renews the lease; an error means another instance may now hold it.
    async fn renew(&mut self, options: &Options) -> Result<(), Error> {
        let started = Instant::now();
        let renewed = tokio::time::timeout(self.stale, store::lease(&mut self.conn, &options.instance, options.lease)).await;
        match renewed {
            Ok(Ok(true)) => {
                self.renewed = started;
                Ok(())
            }
            Ok(Ok(false)) => Err("lost the relay lease".into()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("renewing the relay lease timed out".into()),
        }
    }

    fn check(&self) -> Result<(), Error> {
        if self.renewed.elapsed() > self.stale {
            return Err("relay lease is stale".into());
        }
        Ok(())
    }
}

async fn lead(
    pool: &PgPool,
    js: &jetstream::Context,
    options: &Options,
    active: &AtomicBool,
    held_feeds: &mut HashMap<String, Instant>,
) -> Result<(), Error> {
    // A dedicated connection outside the pool: the lease names its backend pid.
    let mut conn = pool.acquire().await?.detach();
    while !store::lease(&mut conn, &options.instance, options.lease).await? {
        tokio::time::sleep(options.lease / 4).await;
    }
    let mut held = Held { conn, renewed: Instant::now(), stale: options.lease * 3 / 4 };
    active.store(true, Ordering::Relaxed);
    tracing::info!(target: "corten::feed", instance = %options.instance, "relay active");
    let result = publish(pool, js, options, &mut held, held_feeds).await;
    active.store(false, Ordering::Relaxed);
    let _ = store::release(&mut held.conn).await;
    result
}

async fn publish(
    pool: &PgPool,
    js: &jetstream::Context,
    options: &Options,
    held: &mut Held,
    held_feeds: &mut HashMap<String, Instant>,
) -> Result<(), Error> {
    let mut wake = PgListener::connect_with(pool).await?;
    wake.listen("corten_outbox").await?;
    loop {
        drain(pool, js, options, held, held_feeds).await?;
        tokio::select! {
            n = wake.recv() => { n?; }
            // Renew on time even when idle; also a safety net for a lost notification.
            _ = tokio::time::sleep(options.lease / 4) => {}
        }
        if held.renewed.elapsed() >= options.lease / 4 {
            held.renew(options).await?;
        }
    }
}

/// Publishes eligible rows oldest first, pipelining up to `BATCH` acknowledgements.
async fn drain(
    pool: &PgPool,
    js: &jetstream::Context,
    options: &Options,
    held: &mut Held,
    held_feeds: &mut HashMap<String, Instant>,
) -> Result<(), Error> {
    loop {
        if held.renewed.elapsed() >= options.lease / 4 {
            held.renew(options).await?;
        }
        let now = Instant::now();
        held_feeds.retain(|_, retry_at| *retry_at > now);
        let excluded: Vec<&str> = held_feeds.keys().map(String::as_str).collect();
        let rows = store::pending(pool, BATCH, &excluded).await?;
        if rows.is_empty() {
            return Ok(());
        }
        held.check()?;
        let mut acks = Vec::with_capacity(rows.len());
        let mut sent = Vec::with_capacity(rows.len());
        for row in &rows {
            // A refusal can hold a feed after this batch was selected.
            if held_feeds.contains_key(&row.feed) {
                continue;
            }
            if !valid_key(&row.feed) {
                drop_row(pool, options, row, "invalid feed key").await?;
                held.check()?;
                continue;
            }
            match send(js, options, row).await {
                Ok(ack) => acks.push((row, ack)),
                Err(error) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                    // The client did not send this publish. Its limit can be stale.
                    held_feeds.insert(row.feed.clone(), Instant::now() + PAYLOAD_BACKOFF);
                    tracing::warn!(target: "corten::feed", instance = %options.instance, id = row.id, feed = %row.feed,
                        patch_bytes = row.body.len(), reason = "cached NATS max_payload", "outbox feed held");
                }
                Err(error) => return Err(error.into()),
            }
        }
        for (row, ack) in acks {
            if delivered(pool, options, row, ack).await? {
                sent.push(row.id);
            }
        }
        if !sent.is_empty() {
            store::mark_published(pool, &sent).await?;
        }
        if (rows.len() as i64) < BATCH {
            return Ok(());
        }
    }
}

async fn send(js: &jetstream::Context, options: &Options, row: &store::Pending) -> Result<PublishAckFuture, PublishError> {
    let mut headers = HeaderMap::new();
    headers.insert("Nats-Msg-Id", format!("{}:{}:{}", row.feed, row.generation, row.seq).as_str());
    headers.insert("Feed-Generation", row.generation.as_str());
    js.publish_with_headers(subject(options, &row.feed), headers, row.body.clone().into()).await
}

async fn delivered(pool: &PgPool, options: &Options, row: &store::Pending, ack: PublishAckFuture) -> Result<bool, Error> {
    match ack.await {
        Ok(_) => Ok(true),
        Err(error)
            if std::error::Error::source(&error)
                .and_then(|source| source.downcast_ref::<jetstream::Error>())
                .is_some_and(|source| source.error_code() == jetstream::ErrorCode::STREAM_MESSAGE_EXCEEDS_MAXIMUM) =>
        {
            drop_row(pool, options, row, "JetStream MaxMsgSize (10054)").await?;
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

async fn drop_row(pool: &PgPool, options: &Options, row: &store::Pending, reason: &'static str) -> Result<(), Error> {
    if store::mark_published(pool, &[row.id]).await? {
        tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
            patch_bytes = row.body.len(), reason, "dropped outbox row");
    }
    Ok(())
}
