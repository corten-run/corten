//! Outbox relay: sends committed patches to JetStream in order within each feed, but a broker
//! disconnect mid-batch can let queued publishes overtake a failed one. Every instance runs a
//! candidate; the one holding the lease (store::lease) publishes. Delivered patches are marked done
//! after JetStream acknowledges them. A relay that dies or loses its lease in between leaves them to
//! the next one, which republishes them. JetStream drops copies by message ID within its
//! configured deduplication window.
//!
//! Rows with invalid feed keys are logged and marked done without publishing. On a per-publish
//! size refusal the relay publishes a reload marker and waits for its acknowledgement before
//! marking the row done. If the marker fails, the row stays pending without holding up the
//! other acknowledged rows. Patch bodies stay in Postgres until ordinary pruning.

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

use crate::{store, valid_key, Error, Options, RELOAD_HEADER};

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
        let mut refused = Vec::new();
        for row in &rows {
            if !valid_key(&row.feed) {
                refused.push((row, Refusal::InvalidKey));
                continue;
            }
            match send(js, options, row, false).await {
                Ok(ack) => acks.push((row, ack)),
                Err(error) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                    refused.push((row, Refusal::Cached(error)));
                }
                Err(error) => return Err(error.into()),
            }
        }
        for (row, ack) in acks {
            match ack.await {
                Ok(_) => sent.push(row.id),
                Err(error) if stream_size_refusal(&error) => refused.push((row, Refusal::Stream)),
                Err(error) => return Err(error.into()),
            }
        }
        if refused.is_empty() {
            store::mark_published(pool, &sent).await?;
        } else {
            finish_refusals(pool, js, options, held, &mut sent, refused).await?;
        }
        if (rows.len() as i64) < BATCH || sent.is_empty() {
            // A full batch with nothing retired would only select the same rows again.
            return Ok(());
        }
    }
}

async fn send(
    js: &jetstream::Context,
    options: &Options,
    row: &store::Pending,
    reload: bool,
) -> Result<PublishAckFuture, PublishError> {
    let mut headers = HeaderMap::new();
    headers.insert("Nats-Msg-Id", format!("{}:{}:{}", row.feed, row.generation, row.seq).as_str());
    headers.insert("Feed-Generation", row.generation.as_str());
    let body = if reload {
        headers.insert(RELOAD_HEADER, row.seq.to_string().as_str());
        Default::default()
    } else {
        row.body.clone().into()
    };
    js.publish_with_headers(subject(options, &row.feed), headers, body).await
}

fn stream_size_refusal(error: &PublishError) -> bool {
    std::error::Error::source(error)
        .and_then(|source| source.downcast_ref::<jetstream::Error>())
        .is_some_and(|source| source.error_code() == jetstream::ErrorCode::STREAM_MESSAGE_EXCEEDS_MAXIMUM)
}

enum Refusal {
    InvalidKey,
    Cached(PublishError),
    Stream,
}

fn marker_publish_failed(options: &Options, row: &store::Pending, error: impl std::fmt::Display) {
    tracing::warn!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
        %error, "reload marker publish failed; outbox row remains pending");
}

fn marker_size_refused(options: &Options, row: &store::Pending, stream_limit: Option<i32>, error: &PublishError) {
    // NATS header framing and names (including the two ID separators) use 65 bytes.
    // The generation and sequence occur twice each.
    let marker_bytes = row.feed.len() + 65 + 2 * (row.generation.len() + row.seq.to_string().len());
    tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
        marker_bytes, stream = %options.stream, stream_max_message_size = stream_limit, %error,
        "reload marker refused for size; outbox row remains pending");
}

async fn finish_refusals(
    pool: &PgPool,
    js: &jetstream::Context,
    options: &Options,
    held: &mut Held,
    sent: &mut Vec<i64>,
    refused: Vec<(&store::Pending, Refusal)>,
) -> Result<(), Error> {
    held.check()?;
    if held.renewed.elapsed() >= options.lease / 4 {
        held.renew(options).await?;
    }
    // Pipeline the markers too, but bound the whole attempt to leave time to retire
    // acknowledgements before the lease gets stale, even if a marker gets no reply.
    let deadline = (held.renewed + options.lease / 2).into();
    let mut markers = Vec::new();
    let mut completed = Vec::new();
    for (row, refusal) in refused {
        if matches!(refusal, Refusal::InvalidKey) {
            sent.push(row.id);
            completed.push((row, refusal, false));
            continue;
        }
        match tokio::time::timeout_at(deadline, send(js, options, row, true)).await {
            Ok(Ok(ack)) => markers.push((row, refusal, ack)),
            Ok(Err(error)) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                marker_size_refused(options, row, None, &error);
            }
            Ok(Err(error)) => marker_publish_failed(options, row, error),
            Err(error) => marker_publish_failed(options, row, error),
        }
    }
    let mut stream_failed_markers = Vec::new();
    for (row, refusal, ack) in markers {
        match tokio::time::timeout_at(deadline, ack).await {
            Ok(Ok(ack)) => {
                sent.push(row.id);
                completed.push((row, refusal, ack.duplicate));
            }
            Ok(Err(error)) if stream_size_refusal(&error) => stream_failed_markers.push((row, error)),
            Ok(Err(error)) => marker_publish_failed(options, row, error),
            Err(error) => marker_publish_failed(options, row, error),
        }
    }
    // 10054 does not carry the limit. Look it up once for diagnostics only.
    let stream_limit =
        if !stream_failed_markers.is_empty() || completed.iter().any(|(_, refusal, _)| matches!(refusal, Refusal::Stream)) {
            let budget = (options.lease / 8).min(held.stale.saturating_sub(held.renewed.elapsed()));
            tokio::time::timeout(budget, js.get_stream(&options.stream))
                .await
                .ok()
                .and_then(Result::ok)
                .map(|stream| stream.cached_info().config.max_message_size)
        } else {
            None
        };
    for (row, error) in stream_failed_markers {
        marker_size_refused(options, row, stream_limit, &error);
    }
    if sent.is_empty() {
        return Ok(());
    }
    held.check()?;
    let mut retired = store::mark_published_returning(pool, sent).await?;
    retired.sort_unstable();
    for (row, refusal, duplicate) in completed {
        if retired.binary_search(&row.id).is_err() {
            continue;
        }
        let (reason, error) = match refusal {
            Refusal::InvalidKey => {
                tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
                    "dropped outbox row with invalid feed key");
                continue;
            }
            Refusal::Cached(error) => ("refused by the connection's cached limit", Some(error)),
            Refusal::Stream => ("JetStream size refusal (10054)", None),
        };
        let outcome = if duplicate {
            "duplicate reload marker acknowledgement (already accepted notification, kind unknown)"
        } else {
            "published reload marker"
        };
        tracing::error!(target: "corten::feed", instance = %options.instance, id = row.id, feed = ?row.feed,
            patch_bytes = row.body.len(), stream = %options.stream, stream_max_message_size = stream_limit,
            error = error.as_ref().map(tracing::field::display), "{outcome}: {reason}; patch kept for inspection");
    }
    Ok(())
}
