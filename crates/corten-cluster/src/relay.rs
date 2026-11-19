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
    collections::VecDeque,
    future::{poll_fn, Future},
    pin::pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::Poll,
    time::{Duration, Instant},
};

use async_nats::{
    jetstream::{
        self,
        context::{PublishError, PublishErrorKind},
        publish::PublishAck,
        response::Response,
    },
    Client, HeaderMap, HeaderName, Message, StatusCode, Subscriber,
};
use futures_util::{FutureExt, StreamExt};
use sqlx::{postgres::PgListener, PgConnection, PgPool};

use crate::{store, valid_key, Error, Options, RELOAD_HEADER};

/// Outbox rows published per round trip.
const BATCH: i64 = 256;
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn subject(options: &Options, feed: &str) -> String {
    format!("{}.{feed}", options.subject_prefix)
}

/// Runs forever: wait for the lease, publish while holding it, then start over.
pub(crate) async fn run(pool: PgPool, publisher: Publisher, options: Arc<Options>, active: Arc<AtomicBool>) {
    loop {
        if let Err(e) = lead(&pool, &publisher, &options, &active).await {
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

async fn lead(pool: &PgPool, publisher: &Publisher, options: &Options, active: &AtomicBool) -> Result<(), Error> {
    // A dedicated connection outside the pool: the lease names its backend pid.
    let mut conn = pool.acquire().await?.detach();
    while !store::lease(&mut conn, &options.instance, options.lease).await? {
        tokio::time::sleep(options.lease / 4).await;
    }
    let mut held = Held { conn, renewed: Instant::now(), stale: options.lease * 3 / 4 };
    active.store(true, Ordering::Relaxed);
    tracing::info!(target: "corten::feed", instance = %options.instance, "relay active");
    let result = publish(pool, publisher, options, &mut held).await;
    active.store(false, Ordering::Relaxed);
    let _ = store::release(&mut held.conn).await;
    result
}

async fn publish(pool: &PgPool, publisher: &Publisher, options: &Options, held: &mut Held) -> Result<(), Error> {
    let mut wake = PgListener::connect_with(pool).await?;
    wake.listen("corten_outbox").await?;
    let mut inbox = None;
    loop {
        drain(pool, publisher, options, held, &mut inbox).await?;
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
async fn drain(
    pool: &PgPool,
    publisher: &Publisher,
    options: &Options,
    held: &mut Held,
    inbox: &mut Option<ReplyInbox>,
) -> Result<(), Error> {
    loop {
        if held.renewed.elapsed() >= options.lease / 4 {
            held.renew(options).await?;
        }
        let rows = store::pending(pool, BATCH).await?;
        if rows.is_empty() {
            return Ok(());
        }
        held.check()?;
        let mut sent = Vec::with_capacity(rows.len());
        let mut refused = Vec::new();
        {
            let mut replies = Replies::new(publisher, inbox);
            let mut awaiting = Vec::with_capacity(rows.len());
            let window = if publisher.single_reply.load(Ordering::Relaxed) { 1 } else { BATCH as usize };
            for rows in rows.chunks(window) {
                let first = awaiting.len();
                for row in rows {
                    if !valid_key(&row.feed) {
                        refused.push((row, Refusal::InvalidKey));
                        continue;
                    }
                    let slot = awaiting.len();
                    match replies.send(options, row, false, slot, slot != first).await {
                        Ok(()) => awaiting.push(Some(row)),
                        Err(error) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                            awaiting.push(None);
                            refused.push((row, Refusal::Cached(error)));
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
                let deadline = tokio::time::Instant::now() + publisher.timeout;
                let mut had_reply = false;
                for _ in 0..awaiting[first..].iter().flatten().count() {
                    match replies.recv(&mut awaiting, deadline).await {
                        Ok((row, Ok(_))) => sent.push(row.id),
                        Ok((row, Err(error))) if stream_size_refusal(&error) => refused.push((row, Refusal::Stream)),
                        Ok((_, Err(error))) => return Err(error.into()),
                        Err(error) => {
                            // The client does not expose its subscription capacity. A partial
                            // timeout might be overflow; one outstanding reply fits any queue.
                            if had_reply {
                                publisher.single_reply.store(true, Ordering::Relaxed);
                            }
                            return Err(error);
                        }
                    }
                    had_reply = true;
                }
            }
        }
        if refused.is_empty() {
            store::mark_published(pool, &sent).await?;
        } else {
            finish_refusals(pool, publisher, options, held, &mut sent, refused, inbox).await?;
        }
        if (rows.len() as i64) < BATCH || sent.is_empty() {
            // A full batch with nothing retired would only select the same rows again.
            return Ok(());
        }
    }
}

pub(crate) struct Publisher {
    js: jetstream::Context,
    client: Client,
    timeout: Duration,
    single_reply: AtomicBool,
    #[cfg(test)]
    pub(crate) pause_before: Vec<(i64, Arc<tokio::sync::Semaphore>)>,
}

impl Publisher {
    pub(crate) fn new(js: jetstream::Context) -> Self {
        Self {
            client: js.client(),
            js,
            timeout: PUBLISH_TIMEOUT,
            single_reply: AtomicBool::new(false),
            #[cfg(test)]
            pause_before: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

// Reuse one subscription while leading, not the client's map (which retains unanswered
// JetStream requests). Each batch has its own range of reply slots. Abandon the inbox
// when a batch fails so outstanding replies cannot fill the queue during a retry.
struct ReplyInbox {
    name: String,
    subscription: Subscriber,
    next_slot: u64,
}

struct Replies<'a> {
    publisher: &'a Publisher,
    inbox: &'a mut Option<ReplyInbox>,
    first_slot: u64,
    buffered: VecDeque<Message>,
    stats: Arc<async_nats::Statistics>,
    received_before_batch: u64,
}

impl<'a> Replies<'a> {
    fn new(publisher: &'a Publisher, inbox: &'a mut Option<ReplyInbox>) -> Self {
        let first_slot = inbox.as_mut().map_or(0, |inbox| {
            let first = inbox.next_slot;
            inbox.next_slot += BATCH as u64;
            first
        });
        let stats = publisher.client.statistics();
        let received_before_batch = stats.in_messages.load(Ordering::Relaxed);
        Self { publisher, inbox, first_slot, buffered: VecDeque::new(), stats, received_before_batch }
    }

    async fn send(
        &mut self,
        options: &Options,
        row: &store::Pending,
        reload: bool,
        slot: usize,
        pipelined: bool,
    ) -> Result<(), PublishError> {
        let publisher = self.publisher;
        if self.inbox.is_none() {
            let name = publisher.client.new_inbox();
            let subscription = tokio::time::timeout(publisher.timeout, publisher.client.subscribe(format!("{name}.*")))
                .await
                .map_err(|error| PublishError::with_source(PublishErrorKind::TimedOut, error))?
                .map_err(|error| PublishError::with_source(PublishErrorKind::Other, error))?;
            *self.inbox = Some(ReplyInbox { name, subscription, next_slot: BATCH as u64 });
        }
        let inbox = self.inbox.as_mut().expect("the reply subscription was opened");
        let reply = format!("{}.{}", inbox.name, self.first_slot + slot as u64);
        let mut send = pin!(async {
            #[cfg(test)]
            let _permit = if let Some((_, gate)) = publisher.pause_before.iter().find(|(id, _)| *id == row.id) {
                gate.acquire().await.ok()
            } else {
                None
            };
            tokio::time::timeout(publisher.timeout, enqueue(publisher, options, row, reload, reply))
                .await
                .map_err(|error| PublishError::with_source(PublishErrorKind::TimedOut, error))?
        });
        if !pipelined {
            return send.await;
        }
        // Until the client has seen any new message there cannot be a ready reply to
        // this batch. Still listen while a send is blocked, including the first stall.
        // Unrelated traffic only selects the eager drain below; it never counts as an ack.
        if self.stats.in_messages.load(Ordering::Relaxed) == self.received_before_batch {
            if let Some(result) = send.as_mut().now_or_never() {
                return result;
            }
        }
        loop {
            tokio::select! {
                biased;
                Some(reply) = inbox.subscription.next(), if self.buffered.len() < BATCH as usize => {
                    self.buffered.push_back(reply);
                }
                result = &mut send => return result,
            }
        }
    }

    async fn recv<T>(
        &mut self,
        awaiting: &mut [Option<T>],
        deadline: tokio::time::Instant,
    ) -> Result<(T, Result<bool, PublishError>), Error> {
        let inbox = self.inbox.as_mut().expect("an awaiting publish has a reply subscription");
        tokio::time::timeout_at(deadline, async {
            while let Some(reply) = match self.buffered.pop_front() {
                Some(reply) => Some(reply),
                None => inbox.subscription.next().await,
            } {
                let slot = reply_slot(self.first_slot, reply.subject.as_str());
                if let Some(row) = slot.and_then(|slot| awaiting.get_mut(slot)).and_then(Option::take) {
                    return Ok((row, acknowledgement(reply)));
                }
            }
            Err(PublishError::new(PublishErrorKind::BrokenPipe).into())
        })
        .await?
    }

    async fn abandon(self) -> Result<(), Error> {
        // A marker failure need not end leadership. Queue UNSUB before a later batch
        // can open a replacement, even if the client's command queue is full.
        if let Some(mut inbox) = self.inbox.take() {
            tokio::time::timeout(self.publisher.timeout, inbox.subscription.unsubscribe()).await??;
        }
        Ok(())
    }
}

fn reply_slot(first: u64, subject: &str) -> Option<usize> {
    let (_, slot) = subject.rsplit_once('.')?;
    usize::try_from(slot.parse::<u64>().ok()?.checked_sub(first)?).ok()
}

async fn enqueue(
    publisher: &Publisher,
    options: &Options,
    row: &store::Pending,
    reload: bool,
    reply: String,
) -> Result<(), PublishError> {
    let mut headers = HeaderMap::new();
    headers.insert(async_nats::header::NATS_MESSAGE_ID, format!("{}:{}:{}", row.feed, row.generation, row.seq));
    const GENERATION: HeaderName = HeaderName::from_static("Feed-Generation");
    headers.insert(GENERATION, row.generation.as_str());
    let body = if reload {
        headers.insert(RELOAD_HEADER, row.seq.to_string());
        Default::default()
    } else {
        row.body.clone().into()
    };
    publisher.client.publish_with_reply_and_headers(subject(options, &row.feed), reply, headers, body).await.map_err(|error| {
        let kind = if error.kind() == async_nats::client::PublishErrorKind::MaxPayloadExceeded {
            PublishErrorKind::MaxPayloadExceeded
        } else {
            PublishErrorKind::Other
        };
        PublishError::with_source(kind, error)
    })
}

/// The only ack field used by the relay is whether a reload marker was a duplicate.
fn acknowledgement(reply: Message) -> Result<bool, PublishError> {
    if reply.status == Some(StatusCode::NO_RESPONDERS) {
        return Err(PublishError::new(PublishErrorKind::StreamNotFound));
    }
    decode_ack(&reply.payload)
}

fn decode_ack(payload: &[u8]) -> Result<bool, PublishError> {
    // The client's untagged Response tries the error variant first, buffering the
    // entire object and constructing a missing-field error even for ordinary success.
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct PlainAck<'a> {
        #[serde(rename = "stream")]
        _stream: &'a str,
        #[serde(rename = "seq")]
        _sequence: u64,
        #[serde(default)]
        duplicate: bool,
    }
    if payload.first() == Some(&b'{') {
        if let Ok(ack) = serde_json::from_slice::<PlainAck>(payload) {
            return Ok(ack.duplicate);
        }
    }
    // This also preserves error precedence for an object containing both variants.
    match serde_json::from_slice::<Response<PublishAck>>(payload)
        .map_err(|error| PublishError::with_source(PublishErrorKind::Other, error))?
    {
        Response::Ok(ack) => Ok(ack.duplicate),
        Response::Err { error } => Err(PublishError::with_source(PublishErrorKind::Other, error)),
    }
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

async fn poll_send_before<T>(deadline: tokio::time::Instant, send: impl Future<Output = T>) -> Option<T> {
    let mut send = pin!(send);
    // timeout_at polls its inner future first, even if the deadline has passed.
    tokio::time::timeout_at(
        deadline,
        poll_fn(|cx| {
            if tokio::time::Instant::now() >= deadline {
                return Poll::Ready(None);
            }
            send.as_mut().poll(cx).map(Some)
        }),
    )
    .await
    .ok()
    .flatten()
}

async fn finish_refusals(
    pool: &PgPool,
    publisher: &Publisher,
    options: &Options,
    held: &mut Held,
    sent: &mut Vec<i64>,
    refused: Vec<(&store::Pending, Refusal)>,
    inbox: &mut Option<ReplyInbox>,
) -> Result<(), Error> {
    held.check()?;
    if held.renewed.elapsed() >= options.lease / 4 {
        held.renew(options).await?;
    }
    // Pipeline the markers too, but bound the whole attempt to leave time to retire
    // acknowledgements before the lease gets stale, even if a marker gets no reply.
    let deadline = (held.renewed + options.lease / 2).into();
    let mut replies = Replies::new(publisher, inbox);
    let mut markers = Vec::new();
    let mut completed = Vec::new();
    for (row, refusal) in refused {
        if matches!(refusal, Refusal::InvalidKey) {
            sent.push(row.id);
            completed.push((row, refusal, false));
            continue;
        }
        held.check()?;
        let slot = markers.len();
        markers.push(None);
        match poll_send_before(deadline, replies.send(options, row, true, slot, slot != 0)).await {
            Some(Ok(())) => markers[slot] = Some((row, refusal)),
            Some(Err(error)) if error.kind() == PublishErrorKind::MaxPayloadExceeded => {
                marker_size_refused(options, row, None, &error);
            }
            Some(Err(error)) => marker_publish_failed(options, row, error),
            None => marker_publish_failed(options, row, "deadline has elapsed"),
        }
    }
    let mut stream_failed_markers = Vec::new();
    let mut abandoned = false;
    for _ in 0..markers.iter().flatten().count() {
        // Unlike sends, an already-ready acknowledgement is useful even at the deadline.
        match replies.recv(&mut markers, deadline).await {
            Ok(((row, refusal), Ok(duplicate))) => {
                sent.push(row.id);
                completed.push((row, refusal, duplicate));
            }
            Ok(((row, _), Err(error))) if stream_size_refusal(&error) => stream_failed_markers.push((row, error)),
            Ok(((row, _), Err(error))) => marker_publish_failed(options, row, error),
            Err(error) => {
                for (row, _) in markers.into_iter().flatten() {
                    marker_publish_failed(options, row, &error);
                }
                abandoned = true;
                break;
            }
        }
    }
    // 10054 does not carry the limit. Look it up once for diagnostics only.
    let stream_limit =
        if !stream_failed_markers.is_empty() || completed.iter().any(|(_, refusal, _)| matches!(refusal, Refusal::Stream)) {
            let budget = (options.lease / 8).min(held.stale.saturating_sub(held.renewed.elapsed()));
            tokio::time::timeout(budget, publisher.js.get_stream(&options.stream))
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
        return if abandoned { replies.abandon().await } else { Ok(()) };
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
    if abandoned {
        replies.abandon().await
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_and_extended_publish_replies_preserve_the_client_ack_contract() {
        for payload in [
            br#"{"stream":"S","seq":1}"#.as_slice(),
            br#"{"duplicate":true,"seq":4,"stream":"S"}"#,
            br#"{"domain":"D","stream":"S","seq":1,"duplicate":true}"#,
            br#"{"stream":"S\u0031","seq":1}"#,
            br#"{"stream":"S","seq":1,"error":{"code":400,"err_code":10054,"description":"too large"}}"#,
            br#"{"seq":7}"#,
            br#"{"stream":"S","seq":-1}"#,
            br#"{"stream":"S","seq":4,"duplicate":0}"#,
            br#"["S",1,true]"#,
            br#"["S",1,"D",true]"#,
        ] {
            let expected = match serde_json::from_slice::<Response<PublishAck>>(payload) {
                Ok(Response::Ok(ack)) => Ok(ack.duplicate),
                Ok(Response::Err { error }) => Err(error.error_code() == jetstream::ErrorCode::STREAM_MESSAGE_EXCEEDS_MAXIMUM),
                Err(_) => Err(false),
            };
            assert_eq!(decode_ack(payload).map_err(|error| stream_size_refusal(&error)), expected);
        }
    }

    #[test]
    fn a_reused_inbox_distinguishes_batches_by_slot() {
        assert_eq!(reply_slot(256, "_INBOX.test.255"), None);
        assert_eq!(reply_slot(256, "_INBOX.test.256"), Some(0));
        assert_eq!(reply_slot(256, "_INBOX.test.511"), Some(255));
    }

    #[tokio::test]
    async fn an_expired_marker_deadline_does_not_attempt_a_publish() {
        let deadline = tokio::time::Instant::now() - Duration::from_millis(1);
        let mut publishes = 0;
        poll_send_before(deadline, async { publishes += 1 }).await;
        assert_eq!(publishes, 0);
    }
}
