//! Outbox relay: publishes committed patches to JetStream in outbox order. Every instance runs a
//! candidate; the one holding the lease (store::lease) publishes. A patch is marked published only
//! after JetStream acknowledged it. A relay that dies or loses its lease in between leaves it to
//! the next one, which publishes it again, and JetStream drops the copy by its message id. Two
//! relays briefly overlapping is therefore harmless: each publishes the pending rows in order, and
//! the copies are dropped.
//!
//! A row the server can never accept, whatever the relay retries, is rejected instead: its feed
//! key is not a literal NATS subject that fits the control line (written before keys were
//! checked, or by other SQL), or the client refused it as larger than the server's `max_payload`.
//! The relay marks it rejected, logs it once and goes on, so one such row cannot hold back every
//! other feed. Every other publish or acknowledgement failure ends the batch and is retried.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_nats::{
    jetstream::{self, context::PublishErrorKind},
    HeaderMap, Subject,
};
use sqlx::{postgres::PgListener, PgConnection, PgPool};

use crate::{store, valid_key, Error, Options, MAX_FEED_KEY_BYTES};

/// Outbox rows published per round trip.
const BATCH: i64 = 256;

/// Feed `feed`'s subject. The prefix was checked at startup, so with a valid key it is a literal
/// subject that fits a default server's control line.
pub(crate) fn subject(options: &Options, feed: &str) -> Subject {
    Subject::from(format!("{}.{feed}", options.subject_prefix))
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

/// Publishes every pending outbox row, in order, pipelining up to `BATCH` acknowledgements.
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
                let why = format!("its feed key is not a literal NATS subject of at most {MAX_FEED_KEY_BYTES} bytes");
                reject(pool, options, row, &why).await?;
                continue;
            }
            let mut headers = HeaderMap::new();
            headers.insert("Nats-Msg-Id", format!("{}:{}:{}", row.feed, row.generation, row.seq).as_str());
            headers.insert("Feed-Generation", row.generation.as_str());
            let ack = match js.publish_with_headers(subject(options, &row.feed), headers, row.body.clone().into()).await {
                Ok(ack) => ack,
                // Checked before sending, against the server's own limit: retrying cannot pass.
                Err(e) if e.kind() == PublishErrorKind::MaxPayloadExceeded => {
                    reject(pool, options, row, "the patch is larger than the server's max_payload").await?;
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            acks.push(ack);
            sent.push(row.id);
        }
        for ack in acks {
            ack.await?;
        }
        if !sent.is_empty() {
            store::mark_published(pool, &sent).await?;
        }
        if (rows.len() as i64) < BATCH {
            return Ok(());
        }
    }
}

/// Sets `row` aside for an operator, logging it if this relay is the one that rejected it.
async fn reject(pool: &PgPool, options: &Options, row: &store::Pending, why: &str) -> Result<(), Error> {
    if store::reject(pool, row.id, &row.feed).await? {
        // A key may be kilobytes long; its start identifies it next to the row id.
        let feed: String = row.feed.chars().take(80).collect();
        tracing::warn!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?feed,
            feed_bytes = row.feed.len(), "outbox row rejected: {why}; it stays unpublished until repaired");
    }
    Ok(())
}
