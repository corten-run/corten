//! Outbox relay: sends committed patches to JetStream in order within each feed, but a broker
//! disconnect mid-batch can let queued publishes overtake a failed one. Every instance runs a
//! candidate; the one holding the lease (store::lease) publishes. Delivered patches are marked done
//! after JetStream acknowledges them. A relay that dies or loses its lease in between leaves them to
//! the next one, which republishes them, and JetStream drops the copies by message ID. Two
//! relays briefly overlapping can republish these rows within the deduplication window.
//!
//! Rows with invalid feed keys or per-publish size refusals are logged and marked done without
//! delivery. Their bodies stay in Postgres until ordinary pruning; other failures still retry.

use std::{
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
const BATCH: i64 = 256;

pub(crate) fn subject(options: &Options, feed: &str) -> String {
    format!("{}.{feed}", options.subject_prefix)
}

/// Runs forever: wait for the lease, publish while holding it, then start over.
pub(crate) async fn run(pool: PgPool, js: jetstream::Context, options: Arc<Options>, active: Arc<AtomicBool>) {
    loop {
        if let Err(e) = lead(&pool, &js, &options, &active).await {
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

async fn lead(pool: &PgPool, js: &jetstream::Context, options: &Options, active: &AtomicBool) -> Result<(), Error> {
    // A dedicated connection outside the pool: the lease names its backend pid.
    let mut conn = pool.acquire().await?.detach();
    while !store::lease(&mut conn, &options.instance, options.lease).await? {
        tokio::time::sleep(options.lease / 4).await;
    }
    let mut held = Held { conn, renewed: Instant::now(), stale: options.lease * 3 / 4 };
    active.store(true, Ordering::Relaxed);
    tracing::info!(target: "corten::feed", instance = %options.instance, "relay active");
    let result = publish(pool, js, options, &mut held).await;
    active.store(false, Ordering::Relaxed);
    let _ = store::release(&mut held.conn).await;
    result
}

async fn publish(pool: &PgPool, js: &jetstream::Context, options: &Options, held: &mut Held) -> Result<(), Error> {
    let mut wake = PgListener::connect_with(pool).await?;
    wake.listen("corten_outbox").await?;
    loop {
        drain(pool, js, options, held).await?;
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

/// Publishes pending rows oldest first, pipelining up to `BATCH` acknowledgements.
async fn drain(pool: &PgPool, js: &jetstream::Context, options: &Options, held: &mut Held) -> Result<(), Error> {
    loop {
        if held.renewed.elapsed() >= options.lease / 4 {
            held.renew(options).await?;
        }
        let rows = store::pending(pool, BATCH).await?;
        if rows.is_empty() {
            return Ok(());
        }
        held.check()?;
        let mut acks = Vec::with_capacity(rows.len());
        let mut sent = Vec::with_capacity(rows.len());
        for row in &rows {
            if !valid_key(&row.feed) {
                if store::mark_published(pool, &[row.id]).await? {
                    tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
                        "dropped outbox row with invalid feed key");
                }
                held.check()?;
                continue;
            }
            match send(js, options, row).await {
                Ok(ack) => acks.push((row, ack)),
                Err(error) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                    set_aside(pool, options, row, "refused by the connection's cached limit", None).await?;
                    held.check()?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        let mut stream_limit = None;
        for (row, ack) in acks {
            match ack.await {
                Ok(_) => sent.push(row.id),
                Err(error) if stream_size_refusal(&error) => {
                    // 10054 does not carry the limit. Look it up once per refused batch
                    // for diagnostics only; an unavailable limit must not stop the relay.
                    if stream_limit.is_none() {
                        let budget = (options.lease / 8).min(held.stale.saturating_sub(held.renewed.elapsed()));
                        stream_limit = Some(
                            tokio::time::timeout(budget, js.get_stream(&options.stream))
                                .await
                                .ok()
                                .and_then(Result::ok)
                                .map(|stream| stream.cached_info().config.max_message_size),
                        );
                    }
                    set_aside(pool, options, row, "JetStream size refusal (10054)", stream_limit.flatten()).await?;
                }
                Err(error) => return Err(error.into()),
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

fn stream_size_refusal(error: &PublishError) -> bool {
    std::error::Error::source(error)
        .and_then(|source| source.downcast_ref::<jetstream::Error>())
        .is_some_and(|source| source.error_code() == jetstream::ErrorCode::STREAM_MESSAGE_EXCEEDS_MAXIMUM)
}

async fn set_aside(
    pool: &PgPool,
    options: &Options,
    row: &store::Pending,
    reason: &'static str,
    stream_limit: Option<i32>,
) -> Result<(), Error> {
    if store::mark_published(pool, &[row.id]).await? {
        tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
            patch_bytes = row.body.len(), stream = %options.stream, stream_max_message_size = stream_limit,
            "outbox row set aside: {reason}; kept for inspection");
    }
    Ok(())
}
