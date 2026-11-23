//! 1846w's probe (corten-run/corten#1846, not committed): how long a held value waits behind a
//! kept page's brotli 5 job, on the quiet host. 1846r2's probe (round 10's workstation probe with
//! the declared defaults), changed for round 12: every row carries its repetition, the head's job
//! records its request for the store's write lock (the `LOCKING` hook in kept.rs, run once the
//! bytes are made and just before `make_brotli` asks for the lock: when, and whether a
//! `try_write` found the lock held then), and in `contended` the writer takes the lock before the
//! held value is read and, in the head, holds it until the job has asked for it, then keeps its
//! page (the clock's eviction) and lets go. So each contended sample shows that the job asked for
//! the lock while the writer held it and that the writer then ran its eviction under it. Base and
//! head do the same setup; the base has no kept job, so its writer does not wait.
//! A child module of kept.rs, so it keeps pages in a real store and runs a kept page's brotli
//! job as the app queues it: the closure `Kept::coded` gives the worker, `Entry::make_brotli`
//! (encode, the store's write lock, the second check, the room, the attach). Times in
//! microseconds; `-` where a column does not apply.
//!
//!   <build> <rep> <case> <held> <kept> <held_us> <job_us> <locked_us> <ins_start_us> <ins_us>
//!   <evicted> <outcome> <att_us> <att_held> <w_in_us> <w_seen_us> <lockwait_us>
//!
//! case: idle (a held value's forms on an idle worker), room (queued while a kept job with room
//! was about to start encoding), refused (the same, the store has no room for the brotli),
//! contended (the same, the store is full of read pages and another thread keeps a 4 MiB page
//! into it, holding the store's lock through the job's request for it).
//! held_us: from the held value's second read (which queues its job) until its forms exist.
//! job_us: the kept job from after the fence to its end; locked_us: from after the fence to the
//! ADMITTING hook (it holds the store's lock and the second check found the page standing).
//! ins_start_us / ins_us: when the insertion's `Store::keep` call began (from `fence`, the
//! moment the held value had been read, negative before it) and how long the call took.
//! evicted: pages the insertion dropped. att_us: when the job asked for the lock (the LOCKING
//! hook, from `fence`); att_held: 1 when `try_write` found the lock held at that moment, else 0.
//! w_in_us / w_seen_us: when the writer was inside the lock (from its `make` closure, before the
//! held value was read) and when, still inside, it saw the job's request (from `fence`).
//! lockwait_us: from the job's request for the lock to the ADMITTING hook.
//!
//!   <build> <rep> enc - <kept> <us> <bytes>     brotli 5 and its copy alone, on this thread
//!   <build> <rep> heldown <held> - <us>         the held value's brotli 9 and gzip 9 on this thread
use super::*;
#[allow(unused_imports)]
use crate::compress::{Coding, Level, Precompressed};
use std::sync::mpsc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

/// The job's request for the store's write lock, as the head's LOCKING hook records it: when,
/// whether the lock was held then, and a flag the writer waits on.
#[derive(Default)]
struct Attempt {
    came: AtomicBool,
    at: Mutex<Option<(Instant, bool)>>,
}

include!("probe_wait_side.rs");
const VOCAB: [&str; 48] = [
    "trail", "ridge", "river", "stone", "valley", "north", "south", "harbor", "field", "forest", "lake", "summit",
    "path", "bridge", "meadow", "cliff", "orchard", "mill", "station", "market", "garden", "tower", "chapel", "quarry",
    "the", "a", "of", "and", "with", "near", "above", "below", "through", "past", "old", "new",
    "walk", "route", "record", "entry", "notes", "survey", "access", "surface", "terrain", "view", "origin", "material",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn word(&mut self) -> &'static str {
        VOCAB[(self.next() as usize) % VOCAB.len()]
    }
}

/// An HTML page of exactly size bytes: a catalog-like table of records (round 9's).
fn page(size: usize) -> Bytes {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut s = String::with_capacity(size + 1024);
    s.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Records</title><link rel=\"stylesheet\" href=\"/assets/app.3f9a1c27.css\"><script type=\"module\" src=\"/assets/corten.8be1f0a2.js\"></script></head><body><header class=\"c-head-7d1e\"><nav><a href=\"/\">Catalog</a> <a href=\"/records\">Records</a></nav></header><main><h1>Records</h1><table class=\"c-records-1a2b\">");
    let tail = "</table></main><footer class=\"c-foot-7d1e\">Shared catalog</footer></body></html>";
    loop {
        let id = 10_000 + rng.next() % 90_000;
        let mut row = format!(
            "<tr id=\"r-{id}\"><td><a href=\"/records/{id}\">{} {} {}</a></td><td class=\"c-price-1a2b\">{}.{:02}</td><td>",
            rng.word(), rng.word(), rng.next() % 100, rng.next() % 500, rng.next() % 100
        );
        for _ in 0..(6 + rng.next() % 8) {
            row.push_str(rng.word());
            row.push(' ');
        }
        row.push_str("</td></tr>");
        if s.len() + row.len() + tail.len() > size {
            break;
        }
        s.push_str(&row);
    }
    s.push_str(tail);
    while s.len() < size {
        s.push('\n');
    }
    assert_eq!(s.len(), size);
    Bytes::from(s)
}

/// A JSON array of about size bytes, as an API's held document (round 9's).
fn json(size: usize) -> Bytes {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let mut s = String::from("[");
    loop {
        let item = format!(
            "{{\"id\":{},\"name\":\"{} {}\",\"price\":{}.{:02},\"stock\":{},\"tags\":[\"{}\",\"{}\"],\"description\":\"{} {} {} {} {} {}\"}}",
            rng.next() % 1_000_000, rng.word(), rng.word(), rng.next() % 500, rng.next() % 100, rng.next() % 40,
            rng.word(), rng.word(), rng.word(), rng.word(), rng.word(), rng.word(), rng.word(), rng.word()
        );
        if s.len() + item.len() + 2 > size {
            break;
        }
        if s.len() > 1 {
            s.push(',');
        }
        s.push_str(&item);
    }
    s.push(']');
    Bytes::from(s)
}

fn sizes(var: &str, default: &str) -> Vec<usize> {
    std::env::var(var).unwrap_or_else(|_| default.into()).split(',').map(|n| n.trim().parse().unwrap()).collect()
}

fn us(since: Instant, to: Instant) -> f64 {
    to.duration_since(since).as_secs_f64() * 1e6
}

/// A page kept for \`at\` as \`Missed::keep\` keeps one: its key and counts made, its forms per
/// coding empty, its brotli's promotion as \`Coded::of\` starts it.
fn kept_entry(answers: &Answers, at: &str, body: Bytes, used: bool) -> impl FnOnce(Place) -> Entry {
    answers.counts();
    let (hash, written) = (answers.0.keys.hash_one(at), Written::of(&answers.0, at));
    let key = Key::new(at, None, None);
    let size = body.len() + OVERHEAD + key.bytes.len();
    move |place| Entry {
        key,
        hash,
        place,
        written,
        by_language: false,
        data: false,
        made: Instant::now(),
        lifetime: 3600,
        head: HeaderMap::new(),
        cache: crate::cache::Typed::for_test(),
        style: None,
        coded: coded(body.len()),
        body,
        hashed: OnceLock::new(),
        used: AtomicBool::new(used),
        size: AtomicUsize::new(size),
    }
}

/// The held value's second read (it queues the forms), as \`json::Raw\` reads it.
fn read_twice(held: &Arc<Precompressed>) {
    assert!(Precompressed::stored_held(held, Coding::Brotli).is_none());
    assert!(Precompressed::stored_held(held, Coding::Brotli).is_none());
}

fn held_done(held: &Arc<Precompressed>) -> bool {
    Precompressed::stored_held(held, Coding::Brotli).is_some()
}

/// A full store: \`BOUND\` bytes of small pages, each read since the hand last passed, so the
/// insertion's eviction goes round the clock once clearing marks before it drops one.
fn full_store(small: &Bytes) -> Answers {
    let answers = Answers::new(BOUND).expect("a bound");
    let mut n = 0usize;
    loop {
        let at = format!("/s/{n}");
        let one = small.len() + OVERHEAD + at.len();
        if answers.bytes() + one > BOUND - (64 << 10) {
            break;
        }
        answers.keep(kept_entry(&answers, &at, small.clone(), true));
        n += 1;
    }
    answers
}

/// Signed microseconds from `origin` to `t` (negative when `t` is before it).
fn rel(origin: Instant, t: Instant) -> f64 {
    if t >= origin { us(origin, t) } else { -us(t, origin) }
}

fn opt(x: Option<f64>) -> String {
    x.map_or("-".into(), |v| format!("{v:.1}"))
}

/// What the contention thread's insertion saw: the call's start and end, when its `make` ran
/// inside the lock, and when, still inside, it saw the job's request for the lock.
struct Inserted {
    start: Instant,
    end: Instant,
    inside: Instant,
    seen: Option<Instant>,
}

type Insert = Box<dyn FnOnce() -> Inserted + Send>;

fn contention() -> (mpsc::Sender<Insert>, mpsc::Receiver<Inserted>) {
    let (tx, rx) = mpsc::channel::<Insert>();
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for insert in rx {
            let _ = done_tx.send(insert());
        }
    });
    (tx, done_rx)
}
#[test]
#[ignore]
fn wait_probe() {
    let kept = sizes("KEPT_SIZES", "32768");
    let helds = sizes("HELD_SIZES", "4096,79000");
    let reps: usize = std::env::var("REPS").map(|r| r.parse().unwrap()).unwrap_or(21);
    let build = if HEAD { "head" } else { "base" };
    // libtest prints "test <name> ... " with no newline before a --nocapture test's own output:
    // end that line first, so every sample is a line of its own.
    println!();
    let pages: Vec<Bytes> = kept.iter().map(|&k| page(k)).collect();
    let docs: Vec<Bytes> = helds.iter().map(|&h| json(h)).collect();
    let small = Bytes::from(vec![b's'; 64]);
    let big_body = Bytes::from(page(BOUND / SHARE - OVERHEAD - 64).to_vec());
    let (contend, inserted) = contention();
    // The worker's thread starts on first use: start it before anything is timed.
    {
        let held = Arc::new(Precompressed::held(docs[0].clone()));
        read_twice(&held);
        while !held_done(&held) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    for rep in 0..reps {
        for doc in &docs {
            // idle
            let held = Arc::new(Precompressed::held(doc.clone()));
            let a = Instant::now();
            read_twice(&held);
            while !held_done(&held) {
                std::hint::spin_loop();
            }
            let b = Instant::now();
            println!("{build}\t{rep}\tidle\t{}\t-\t{:.1}\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t-", doc.len(), us(a, b));
            for body in &pages {
                for case in ["room", "refused", "contended"] {
                    let answers = match case {
                        "room" => Answers::new(BOUND).unwrap(),
                        "refused" => Answers::new(body.len() + OVERHEAD + 2 + 64).unwrap(),
                        _ => full_store(&small),
                    };
                    let entry = answers.keep(kept_entry(&answers, "/p", body.clone(), true));
                    let before = answers.0.inner.read().unwrap().at.len();
                    let held = Arc::new(Precompressed::held(doc.clone()));
                    let (go_tx, go) = mpsc::channel::<()>();
                    let (started_tx, started) = mpsc::channel::<()>();
                    let (done_tx, done) = mpsc::channel();
                    let attempt = Arc::new(Attempt::default());
                    let queued = queue_kept(&entry, attempt.clone(), started_tx, go, done_tx);
                    if queued {
                        started.recv().unwrap();
                    }
                    // The worker is now held at the fence (head) or idle (base). In contended, the
                    // writer takes the store's lock before the held value is read; in the head it
                    // holds it until the job has asked for it.
                    if case == "contended" {
                        let store = Answers(answers.0.clone());
                        let big = big_body.clone();
                        let waits = queued;
                        let attempt = attempt.clone();
                        let (inside_tx, inside_rx) = mpsc::channel::<()>();
                        let insert: Insert = Box::new(move || {
                            let make = kept_entry(&store, "/big", big, false);
                            let (mut inside, mut seen) = (None, None);
                            let start = Instant::now();
                            store.keep(|place| {
                                inside = Some(Instant::now());
                                let _ = inside_tx.send(());
                                if waits {
                                    let until = Instant::now() + Duration::from_secs(2);
                                    while !attempt.came.load(Ordering::Acquire) && Instant::now() < until {
                                        std::hint::spin_loop();
                                    }
                                    if attempt.came.load(Ordering::Acquire) {
                                        seen = Some(Instant::now());
                                    }
                                }
                                make(place)
                            });
                            let end = Instant::now();
                            Inserted { start, end, inside: inside.unwrap(), seen }
                        });
                        contend.send(insert).unwrap();
                        inside_rx.recv().unwrap();
                    }
                    let a = Instant::now();
                    read_twice(&held);
                    let fence = Instant::now();
                    let _ = go_tx.send(());
                    while !held_done(&held) {
                        std::hint::spin_loop();
                    }
                    let b = Instant::now();
                    let (job_us, locked_us, locked, outcome) = if queued {
                        let (resumed, locked, ended, outcome): (Instant, Option<Instant>, Instant, &str) = done.recv().unwrap();
                        assert!(ended <= b, "the held value waited for the kept job");
                        (Some(us(resumed, ended)), locked.map(|l| us(resumed, l)), locked, outcome)
                    } else {
                        (None, None, None, "-")
                    };
                    let tried = *attempt.at.lock().unwrap();
                    let lockwait = match (tried, locked) {
                        (Some((at, _)), Some(l)) => Some(rel(at, l)),
                        _ => None,
                    };
                    let (ins_start, ins_us, evicted, w_in, w_seen) = if case == "contended" {
                        let i = inserted.recv().unwrap();
                        let after = answers.0.inner.read().unwrap().at.len();
                        (
                            Some(rel(fence, i.start)),
                            Some(us(i.start, i.end)),
                            Some(before + 1 - after),
                            Some(rel(fence, i.inside)),
                            i.seen.map(|s| rel(fence, s)),
                        )
                    } else {
                        (None, None, None, None, None)
                    };
                    println!(
                        "{build}\t{rep}\t{case}\t{}\t{}\t{:.1}\t{}\t{}\t{}\t{}\t{}\t{outcome}\t{}\t{}\t{}\t{}\t{}",
                        doc.len(),
                        body.len(),
                        us(a, b),
                        opt(job_us),
                        opt(locked_us),
                        opt(ins_start),
                        opt(ins_us),
                        evicted.map_or("-".into(), |e| e.to_string()),
                        opt(tried.map(|(at, _)| rel(fence, at))),
                        tried.map_or("-", |(_, held)| if held { "1" } else { "0" }),
                        opt(w_in),
                        opt(w_seen),
                        opt(lockwait),
                    );
                    drop(entry);
                }
            }
        }
        for body in &pages {
            let t = Instant::now();
            let out = Bytes::copy_from_slice(&encode_kept(body));
            let e = Instant::now();
            println!("{build}\t{rep}\tenc\t-\t{}\t{:.1}\t{}", body.len(), us(t, e), out.len());
        }
        for doc in &docs {
            let t = Instant::now();
            let br = crate::compress::encode(Coding::Brotli, doc, Level::Held);
            let gz = crate::compress::encode(Coding::Gzip, doc, Level::Held);
            let e = Instant::now();
            std::hint::black_box((br, gz));
            println!("{build}\t{rep}\theldown\t{}\t-\t{:.1}", doc.len(), us(t, e));
        }
        eprintln!("{build} rep {rep} done");
    }
}