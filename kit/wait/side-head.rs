// 1846w's probe: the head's side of probe_wait.rs (1846r2's, which round 10 wrote, with the
// LOCKING hook recording the job's request for the store's lock).
const HEAD: bool = true;

fn coded(length: usize) -> Coded {
    Coded::of(length)
}

/// The job `Kept::coded` queues for a page (`Turn::Kept`), held at a fence after it starts so
/// the held value is queued before the encode begins, with the times of its parts. At its
/// request for the store's write lock (LOCKING, once the bytes are made) it records the time and
/// whether a `try_write` found the lock held, then sets the flag a writer waits on.
#[allow(clippy::type_complexity)]
fn queue_kept(
    entry: &Arc<Entry>,
    attempt: Arc<Attempt>,
    started: mpsc::Sender<()>,
    go: mpsc::Receiver<()>,
    done: mpsc::Sender<(Instant, Option<Instant>, Instant, &'static str)>,
) -> bool {
    assert!(entry.body.len() <= BROTLI_MAX, "a page the app gives a brotli 5");
    let page = Arc::downgrade(entry);
    crate::compress::later(
        Turn::Kept,
        Box::new(move || {
            let _ = started.send(());
            go.recv().unwrap();
            let resumed = Instant::now();
            let (locked_tx, locked_rx) = mpsc::channel();
            super::ADMITTING.set(Some(Box::new(move || {
                let _ = locked_tx.send(Instant::now());
            })));
            let mut outcome = "skipped";
            if let Some(entry) = page.upgrade() {
                if let Some(store) = entry.place.store.upgrade() {
                    let attempt = attempt.clone();
                    super::LOCKING.set(Some(Box::new(move || {
                        let held = matches!(store.inner.try_write(), Err(std::sync::TryLockError::WouldBlock));
                        *attempt.at.lock().unwrap() = Some((Instant::now(), held));
                        attempt.came.store(true, Ordering::Release);
                    })));
                }
                entry.make_brotli();
                outcome = if entry.coded.brotli.get().is_some() {
                    "admitted"
                } else if entry.size.load(Ordering::Acquire) == GONE {
                    "gone"
                } else {
                    "refused"
                };
            }
            let ended = Instant::now();
            let _ = super::ADMITTING.take();
            let _ = super::LOCKING.take();
            let _ = done.send((resumed, locked_rx.try_recv().ok(), ended, outcome));
        }),
    )
}

fn encode_kept(body: &[u8]) -> Vec<u8> {
    crate::compress::encode(Coding::Brotli, body, Level::Kept)
}
