//! The answers the app keeps to send again: pages, and whole bodies of JSON, text or a file.
//!
//! A page whose route says its answer is the same for everyone ([`crate::Public`]) is one every
//! shared cache may keep for the lifetime it names. The app is the first of them: it keeps the
//! whole document its handler made for a `GET` that tells nothing about who is asking, and for
//! that lifetime (`s-maxage` where the answer has one, else `max-age`, RFC 9111 section 4.2.1)
//! gives it to the next such request in the handler's place, with an `Age`.
//!
//! While the store has room every such answer is kept. Once it is full, keeping an answer may
//! drop another page, so an answer is kept then only when its URL was asked for before, as far
//! back as the marks that say so go ([`Store::asked`]): a crawler's first walk over more URLs
//! than the bound has room for, or searches no one repeats, are answered by the handler without
//! a copy into the store, and all but the few whose mark is another's take no room from the
//! pages that are asked for again.
//!
//! It stands where the handler does, after the app's middleware, so every stage still runs for
//! every request: a middleware sees the `200` with the whole body, the security headers and
//! `Cache-Control` are written as for any answer, and a request that names the page's tag is
//! answered `304`. What a kept page saves is the handler, the render, the hash of its body for the
//! tag and its compression: the hash and each coding's bytes are made once and stay with it
//! ([`Kept`], which [`crate::cache::tag`] and `compress::finish` read).
//!
//! What makes this safe is checked when the app compiles: a `Public` handler takes only inputs
//! that cannot tell who is asking ([`crate::answer::Anonymous`]), and a page is kept only when
//! each of them is one of Corten's own whose reading of a page's request the key covers
//! (`Anonymous::KEYED`). An extractor of the app's own may read another header and still not
//! tell who asks, so a page whose handler takes one is made for every request. The request must
//! show nothing else the page could differ by: no cookie but the time zone's (a `Public` page is
//! written in UTC), no `Authorization`, no caller read by a middleware, no `corten` header, JSON
//! not asked for first, no notice sent back, no body, and the URL the router matched (a
//! middleware that changed it since leaves the request to the handler). The key is the `Host`,
//! the path and query, and `Accept-Language` when the page's `Vary` names it (`App::messages`, or
//! a locale negotiated from it, before or after the page was made, which a copy given says again
//! as it leaves the app, whatever `Vary` a middleware put on it): a page for `/items?page=2` is
//! not the one for `/items`. The headers are compared as they were sent, so `fr` and `fr-FR`
//! each have a copy. An answer is
//! kept only when it is a `200` of a known size with a lifetime, sets no cookie, drew no nonce
//! and no value made for this request alone, varies on nothing but what the key covers, and has
//! at most [`NAMES`] header names.
//!
//! A `Public` route whose answer is JSON (`Json<T>`, `JsonResult<T>`), text or a file (`Media`,
//! a sitemap or `robots.txt` of [`crate::seo`]) is kept the same
//! way, under the same rules and by the same key, from a size: its whole body, of 1,024 bytes
//! or more ([`BODY_FROM`]), whatever its type and in every build, for a `GET` that
//! shows nothing about who is asking ([`Shape::Body`]). A kept body saves its handler, its
//! writing, its compression where the app compresses it, and the hash of its tag, which a
//! request that names a coding pays for whether or not the body is compressed. A smaller body
//! is left to its handler: the hash grows with the body and the instructions asking the store
//! costs do not (by their counts a body named with a coding gains from about 350 bytes; no
//! size under 1,024 was run). A route whose bodies are all too small stops
//! asking ([`Unkept`]). Once kept, a body is given to a request that accepts no coding as well.
//! Which answers are whole bodies is known from the
//! route's type when the app compiles ([`crate::answer::Answer::WHOLE`], which an answer type of
//! the app's own cannot claim). Such a route has one answer at its URL, where a page route has
//! the document, its swap and its data, so a request that asks for JSON first is kept too, as a
//! copy apart from one that does not: a handler that takes `Req` can read which of the two
//! asked (`req.mode`). What an API adds for the site that asks (`Access-Control-Allow-Origin`,
//! `Vary: origin`) is written after the handler for each request, and is no part of what is
//! kept. An answer with markup its handler rendered that holds a form's new submit key is that
//! request's alone: a page's render marks one, and the handler of every route whose answer may be
//! `Public` is watched for one drawn any other way, on the thread that runs it (`form::KeyWatch`),
//! which marks the answer too (`cache::Unrepeatable`), so no cache in front shares it either. JSON
//! the app holds as bytes
//! (`json::Raw`) carries its own compressed forms in a build that compresses, a mark this does
//! not replay, so it is its handler's for every request, which costs it no writing and no
//! compression. A file is kept as text is, whatever its type: a picture no build compresses
//! (PNG, JPEG, WebP) is kept for its tag's hash. Left to its handler for every request are a
//! file sent as a
//! stream (`Media::stream`), which has no body to hold, and one at a URL that names its content
//! (`Public::immutable`), which says no lifetime the app keeps it for and is left to the caches
//! that keep it for a year. A kept file is sent with the headers its handler gave it, its
//! `Content-Disposition` among them. Any other answer (a relay, a
//! stream, a feed, a status alone) is its handler's for every request, but for what a page route
//! answers in a page's place: a file of a known size from a route that says it answers a page
//! or a file (`PageOr`), and an answer type of the app's own that says it is a page, are kept
//! as the page would be.
//!
//! A write drops what is kept at its path, whatever the query (a named post is `?do=name` at its
//! page's path) and however the path is escaped, whatever it is answered: a handler or a
//! middleware that refused it, failed, passed its deadline or lost its client may have written
//! first, and a status does not say. Work that outlives its request
//! ([`crate::Signal::finish`]) counts again when it ends. So a client can have a kept page made
//! again by sending a write to its path: each copy is made when it is next asked for, at what the
//! page cost before the app kept pages and the copy into the store. A write that does not reach
//! the app's middleware (another site's, one for another host) is not counted.
//! A write that went through also drops what is kept at the place on this site its
//! answer names (`Location`, `Content-Location`; RFC 9111 section 4.4). A page whose handler
//! was reading while a write went through is not kept. Nothing else drops a page before its
//! lifetime ends, but a write from before the app counted writes by path (below): the lifetime
//! is how stale the app said the page may be. Off in an app with no route that keeps a page,
//! whose writes are then not counted. Under `corten dev` the store stands and counts writes, so
//! the code that decides what it keeps runs, but it keeps nothing and gives nothing: each
//! `Public` route says in the log instead whether a release build would keep its answer while
//! the store has room, and if not why ([`Verdict`]). The
//! bound is [`crate::App::kept_answers`], and counts each page's bytes, its headers, its key and
//! the compressed forms made for it, with an allowance for what holds them; the body, the key,
//! the head's lines and each compressed form are held in allocations of their own size
//! (`tests/kept_memory.rs` holds the count to what the allocator is asked for). The key is
//! built when an answer is kept, so a miss that is not kept never builds it ([`Key`]).
//!
//! A write is counted when it is answered or dropped, so what it changes must be there for a
//! reader by then, or be made under `Signal::finish`. One that lands later (a task the handler
//! started and did not wait for, a store whose readers lag its writers) can leave the page as
//! it was until its lifetime ends.
//!
//! Writes are counted by path once the app has made an answer it may keep, and not before: an
//! app can have a store and keep nothing in it (its `Public` text is all too small, which is
//! known only as each answer is made), and until then a write reads nothing of its path and
//! adds one to a count of all such writes. An answer stands only while that count is as its
//! request found it, so a write that began before the counts by path were made and ends after
//! drops every answer kept by then, at whatever path, and so does work it left
//! ([`crate::Signal::finish`]) each time some ends: nothing of its path was read to count by.

use std::cell::Cell;
use std::collections::HashMap;
use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher, Hasher, RandomState};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
#[cfg(feature = "compress")]
use std::sync::Weak;
use std::sync::{Arc, OnceLock, PoisonError, RwLock};
use std::time::Instant;

use bytes::Bytes;
use http::uri::PathAndQuery;
use http::{header, HeaderMap, HeaderValue, StatusCode};

use crate::body::Body;
use crate::handler::Request;
use crate::page::Mode;
use crate::response::Response;

/// [`crate::App::kept_answers`] unless set: 32 MiB.
pub(crate) const BOUND: usize = 32 << 20;

/// The share of the bound one answer may take: a larger one is not kept.
const SHARE: usize = 8;

/// The copies kept for one URL, one for each `Host`, `Accept-Language` and way of asking (a
/// whole body's, for a data client or not) it was asked with: a new one past this takes the
/// place of the oldest.
const COPIES: usize = 8;

/// What an entry counts for beside its key, its headers and its bytes: itself and its places in
/// the maps.
const OVERHEAD: usize = 1024;

/// What a header counts for beside its name and value: its place in the head's lines.
const HEADER: usize = 112;

/// An entry's size once it is no longer kept: nothing made for it counts from then on.
const GONE: usize = usize::MAX;

/// Room for the names the stages after the handler add to a kept answer's head, so it does not
/// grow as they are written: `Age`, the tag, the security headers, the reporting endpoints and
/// what compression writes are twelve at most. A middleware of the app that adds more grows it as
/// it would any other.
const ADDED: usize = 12;

/// The most names a kept answer's head has: one with more is its handler's to answer for every
/// request. Far more than a page's, and few enough that a map of them with room for [`ADDED`]
/// more, and what crowding makes `http` grow it to, stays far below the most a map holds (24,576
/// names in `http` 1.5, past which making or filling one panics), so a request given a kept
/// answer adds its `Age` and the stages their headers as they would to its handler's.
pub(crate) const NAMES: usize = 1024;

/// `Last-Event-ID`, held once: a comparison with a name that is not the `http` crate's own
/// would make the name each time.
static LAST_EVENT_ID: header::HeaderName = header::HeaderName::from_static("last-event-id");
/// [`crate::page::NOTICE_HEADER`], held once for the same reason.
static NOTICE: header::HeaderName = crate::page::NOTICE_HEADER;

/// The ages, in seconds, whose `Age` is written without an allocation: those of up to four
/// digits, two hours and three quarters, which takes in a lifetime of an hour.
const AGES: u64 = 10_000;

/// Every whole number under [`AGES`] in decimal, one after another (`0123456789101112`, on to
/// `9999`): an `Age` is a slice of it.
static DIGITS: &str = {
    const LENGTH: usize = 10 + 90 * 2 + 900 * 3 + 9_000 * 4;
    static BYTES: [u8; LENGTH] = {
        let mut bytes = [0; LENGTH];
        let (mut at, mut number) = (0, 0);
        while number < AGES {
            let mut place = match number {
                0..10 => 1,
                10..100 => 10,
                100..1_000 => 100,
                _ => 1_000,
            };
            while place > 0 {
                bytes[at] = b'0' + (number / place % 10) as u8;
                at += 1;
                place /= 10;
            }
            number += 1;
        }
        // A length that is not the digits' fails the build: too short is an index past the
        // end above, too long is this.
        assert!(at == LENGTH);
        bytes
    };
    match std::str::from_utf8(&BYTES) {
        Ok(digits) => digits,
        Err(_) => panic!("digits are text"),
    }
};

/// An `Age` of `seconds`. Under [`AGES`] it is a slice of [`DIGITS`], where a value made from the
/// number is two allocations for every answer given again: about 900 instructions of the 39,000
/// a kept file's request took (docs/design.md#choice-kept-pages). An older answer's is made
/// from the number.
fn age_value(seconds: u64) -> HeaderValue {
    // Where the numbers of this many digits begin in `DIGITS`, and the first of them.
    let (digits, from, first) = match seconds {
        0..10 => (1, 0, 0),
        10..100 => (2, 10, 10),
        100..1_000 => (3, 190, 100),
        1_000..AGES => (4, 2_890, 1_000),
        _ => return HeaderValue::from(seconds),
    };
    let at = from + (seconds - first) as usize * digits;
    HeaderValue::from_static(&DIGITS[at..at + digits])
}

/// A kept answer's head: its lines in the order its map gave them, each name as many times as it
/// has values, in one allocation of their number. A copy of the handler's map would hold its
/// table of places beside the lines and the room it grew to, as long as the answer is kept: 576
/// bytes of jemalloc's for a page's four lines, where these take 320 (docs/design.md#choice-kept-pages).
/// A request given the answer makes a map of them all the same ([`with_room`]).
type Head = Box<[(header::HeaderName, HeaderValue)]>;

/// The lines of `headers`, in the order a map made of them again gives them back.
fn head_of(headers: &HeaderMap) -> Head {
    let mut lines = Vec::with_capacity(headers.len());
    lines.extend(headers.iter().map(|(name, value)| (name.clone(), value.clone())));
    lines.into_boxed_slice()
}

/// A map of a kept answer's `head`, whose map had `names` names (at most [`NAMES`]), each line
/// where it was, with room for [`ADDED`] more names: a map made just large enough grows on the
/// first name a stage adds, and moves its lines. The room is for names and not lines, since a
/// name's second and later values are held beside the map's table.
fn with_room(head: &[(header::HeaderName, HeaderValue)], names: usize) -> HeaderMap {
    let mut copy = HeaderMap::with_capacity(names + ADDED);
    for (name, value) in head {
        copy.append(name.clone(), value.clone());
    }
    copy
}

/// The counts of writes, one for the paths whose hash names it: enough of them (256 KiB, made
/// with the first answer that may be kept) that an app's writes seldom share a count with a
/// kept page.
const WRITES: usize = 1 << 16;

/// What a route that is kept answers, known when the app compiles: a page, kept as the whole
/// document a browser loads, or a whole body (JSON, text, a file), kept for whoever asks. Public in a
/// private module, as the `Handler` whose `keeps` names it is: an app cannot name it.
#[derive(Clone, Copy, PartialEq)]
pub enum Shape {
    Page,
    Body,
}

/// What `corten dev` says of a `Public` answer, where nothing is kept: that a release build would
/// keep it while its store has room, or the first reason it does not, as the code that decides
/// found it. A reason decided when the route is made comes from its handler's type
/// (`crate::handler::Handler::public`). One decided before the handler runs comes from
/// [`Asked::checked`], the code of [`Asked::of`] in a copy of its own that only `corten dev` runs
/// (`crate::router::Telling`). A drawn submit key comes from the watch the route keeps by, where a
/// release build gives the answer as it is ([`Missed::drew_key`]), and one decided by the answer
/// from [`Missed::keep`], whose copy for `corten dev` (`TELL`) records each in the request's
/// signal ([`Verdict::found`]). `Kept`, or `Unread`, comes from the body of an answer a release
/// build would keep, as `corten dev` reads it ([`tell_read`]): that build reads it whole before
/// the answer leaves, within the route's deadline, and `corten dev` only as it is sent, after, so
/// of a body it reads that way each says what `corten dev` saw and leaves what that build does
/// with the body to that read: a slow body may meet the deadline there, and one that fails
/// after the request's signal ends may read whole there. What a request alone decides (a
/// cookie, a navigation, a write) is not said: the page's verdict is for the request that shows
/// nothing about who asks. Nor is a full store, which the store under `corten dev`, holding
/// nothing, never is: `Kept` says the answer may be kept, not that it is. Public in a private
/// module, as [`Shape`] is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Verdict {
    Kept {
        lifetime: u64,
        /// Its body was read under `corten dev` as it was sent, after its route answered, not
        /// held whole: a release build keeps it if it reads it whole within the route's deadline.
        read: bool,
    },
    /// The app keeps no answers: its bound is 0 (`crate::App::kept_answers`).
    Off,
    /// Its handler takes an input the key does not cover (`Anonymous::KEYED`).
    Unkeyed,
    /// Its answer is neither a page nor a whole body (`Answer::WHOLE`).
    NotWhole,
    /// Its route says `unstaged`: no stage gives the request its signal.
    Unstaged,
    /// Something read a caller for the request.
    Caller,
    /// A middleware changed the URL the router matched.
    Rewritten,
    /// It drew a form's new submit key.
    DrewKey,
    /// No lifetime a shared cache keeps it for (`crate::cache::Typed::shared`), with its status.
    NoLifetime {
        status: u16,
    },
    Varies,
    Status(u16),
    /// A mark not put back on a kept answer, or not `Public`'s.
    Marked,
    SetsCookie,
    Encoded,
    Range,
    Tagged,
    Names,
    Nonce,
    Slow {
        took: u64,
        lifetime: u64,
    },
    Unsized,
    Small(u64),
    Empty,
    Large {
        size: usize,
        bound: usize,
    },
    Written,
    /// Its body, of a known size, failed as `corten dev` read it, after its route answered. A
    /// release build reads it before then, so what it does with it is not known here.
    Unread,
}

impl Verdict {
    /// The request's answer has this verdict, unless an earlier one was found for it: under
    /// `corten dev` alone, where the route says it ([`Verdict::tell`]).
    #[cold]
    pub(crate) fn found(self, signal: &crate::Signal) {
        let _ = signal.found::<Verdict>().set(self);
    }

    /// The verdict found for the request, if one was.
    pub(crate) fn of(signal: &crate::Signal) -> Option<Verdict> {
        signal.found::<Verdict>().get().copied()
    }

    /// Its bit among the verdicts a route has said: one for each kind, whatever its numbers. A
    /// body held whole and one read as it was sent are kept on different terms (the second only if
    /// a release build reads it within the route's deadline), so each has its own.
    fn bit(self) -> u32 {
        let at = match self {
            Verdict::Kept { read: false, .. } => 0,
            Verdict::Kept { read: true, .. } => 25,
            Verdict::Off => 1,
            Verdict::Unkeyed => 2,
            Verdict::NotWhole => 3,
            Verdict::Unstaged => 4,
            Verdict::Caller => 5,
            Verdict::Rewritten => 6,
            Verdict::DrewKey => 7,
            Verdict::NoLifetime { .. } => 8,
            Verdict::Varies => 9,
            Verdict::Status(_) => 10,
            Verdict::Marked => 11,
            Verdict::SetsCookie => 12,
            Verdict::Encoded => 13,
            Verdict::Range => 14,
            Verdict::Tagged => 15,
            Verdict::Names => 16,
            Verdict::Nonce => 17,
            Verdict::Slow { .. } => 18,
            Verdict::Unsized => 19,
            Verdict::Small(_) => 20,
            Verdict::Empty => 21,
            Verdict::Large { .. } => 22,
            Verdict::Written => 23,
            Verdict::Unread => 24,
        };
        1 << at
    }

    /// Says it in the log for the route whose request for `path` it is, unless the route said it
    /// before: `told` holds a bit for each verdict the route has said ([`Verdict::bit`]: a reason
    /// once, whatever its numbers), so a page loaded again says nothing new, and one that changes
    /// how it answers says so. `corten dev` starts the app again on each change, so a changed
    /// route starts over.
    pub(crate) fn tell(self, path: &str, told: &AtomicU32) {
        let bit = self.bit();
        if told.load(Ordering::Relaxed) & bit != 0 || told.fetch_or(bit, Ordering::Relaxed) & bit != 0 {
            return;
        }
        // Of a body read as it was sent, what `corten dev` saw, and no more: a release build reads it
        // before the answer leaves, under the route's deadline and before the request's signal
        // ends, where it may be slower or read otherwise.
        match self {
            Verdict::Kept { lifetime, read: false } => tracing::info!(
                "corten: {path} is Public, and a release build would keep its answer for {lifetime} s while its store has room, given in its handler's place to each GET that shows nothing about who asks (under corten dev its handler makes every answer)"
            ),
            Verdict::Kept { lifetime, read: true } => tracing::info!(
                "corten: {path} is Public, and a release build would keep its answer for {lifetime} s while its store has room if it reads the body whole within the route's deadline, given in its handler's place to each GET that shows nothing about who asks (a release build reads the body before the answer leaves; corten dev read it whole only as it was sent, after the route answered, and its handler makes every answer)"
            ),
            Verdict::Unread => tracing::warn!(
                "corten: {path} is Public, and its body, of a known size, failed as corten dev read it, after the route answered: a release build reads it before the answer leaves, within the route's deadline, and keeps the answer only if the body reads whole there"
            ),
            _ => tracing::warn!("corten: {path} is Public, but a release build does not keep its answer: {}", self.why()),
        }
    }

    /// Why it is not kept, and what to change, for an author.
    fn why(self) -> String {
        match self {
            Verdict::Kept { .. } | Verdict::Unread => String::new(),
            Verdict::Off => "the app keeps no answers, since its bound is 0 (App::kept_answers(0)); give it a bound to have answers kept".into(),
            Verdict::Unkeyed => "its handler takes an input the kept answer's key does not cover (an extractor of the app's own, an Option, Json, an Upload, LiveSince or Since, or a Form before its last argument), so it runs for every request; read what the URL gives with Params or Uri instead".into(),
            Verdict::NotWhole => "its answer is neither a page nor a whole body (a stream, a relay, a feed or a status alone), so its handler runs for every request".into(),
            Verdict::Unstaged => "its route says unstaged, and no stage gives the request what keeping its answer needs; leave unstaged out to have it kept".into(),
            Verdict::Caller => "something read a Caller for the request (a middleware, or the layout), which makes the answer that caller's; read a caller only where the answer is not Public".into(),
            Verdict::Rewritten => "a middleware changed its URL after the router matched it, so the URL no longer names the page its handler makes; change the URL in a layer in front (App::layer), or redirect".into(),
            Verdict::DrewKey => "it draws a form's new submit key (SubmitKey::field), and each visitor needs a key of their own; put the form on a page that is not Public".into(),
            Verdict::NoLifetime { status } if !(200..400).contains(&status) => Verdict::Status(status).why(),
            Verdict::NoLifetime { .. } => "it has no lifetime a shared cache keeps it for (Public::new with 0 seconds, or Public::immutable, which the caches in front keep for a year); give it a lifetime of a second or more".into(),
            Verdict::Varies => "its Vary names a header the key does not cover (of a request's headers only Accept-Language is part of the key); leave that header out of Vary, or answer it private".into(),
            Verdict::Status(status) => format!("it answered {status}, and only a 200 is kept"),
            Verdict::Marked => "its answer carries a mark the app does not put back on a kept answer (an extension of its handler's, or an answer type of the app's own); return the answer Public made as it is".into(),
            Verdict::SetsCookie => "it sets a cookie; set it on an answer that is not Public".into(),
            Verdict::Encoded => "it says a Content-Encoding (its handler compressed it); leave compressing to the app".into(),
            Verdict::Range => "it answers a range of its body (Content-Range)".into(),
            Verdict::Tagged => "it has an ETag of its own; the app tags the answers it keeps itself".into(),
            Verdict::Names => format!("it has more than {NAMES} header names"),
            Verdict::Nonce => "its HTML has this request's CSP nonce (req.nonce() in the layout, or a handler that takes Nonce); move the inline script or style into a component's file".into(),
            Verdict::Slow { took, lifetime } => format!("it took {took} s to make, as long as its lifetime of {lifetime} s or longer; give it a longer one"),
            Verdict::Unsized => "its body's size is not known before it is sent (a stream, Media::stream)".into(),
            Verdict::Small(length) => format!("its body is {length} bytes, and a whole body is kept from {BODY_FROM} (a smaller one costs less to make again than to look up)"),
            Verdict::Empty => "its body is empty".into(),
            Verdict::Large { size, bound } => format!("it takes {size} bytes, more than an eighth of the {bound} the app keeps (App::kept_answers); raise the bound to have it kept"),
            Verdict::Written => "a write to its path went through while its handler read, so it may show what was there before; the next answer may be kept".into(),
        }
    }
}

/// How many answers in a row a route of whole bodies makes with none kept before it stops
/// asking the store ([`Unkept`]).
const UNKEPT_RUN: u8 = 64;

/// Where each thread's draws start ([`Unkept::leaves`]): any number but zero. Every thread
/// starts here, so each leaves its first 364 requests for routes that left the store out to
/// their handlers before one asks, once in the life of a thread.
const DRAWN_FROM: u32 = 0x9E37_79B9;

thread_local! {
    /// This thread's last draw of which request a route that left the store out asks it for.
    static DRAWN: Cell<u32> = const { Cell::new(DRAWN_FROM) };
}

/// A route of whole bodies, by what became of the answers it made last. A body is kept from
/// a size ([`BODY_FROM`]), which no type
/// of the route's shows, so a route whose bodies are all under that size, or all
/// streams or files their URLs name, would ask the store, find nothing, and have every
/// answer refused: about as much again as a handler that answers a constant costs. After
/// [`UNKEPT_RUN`] answers in a row of which none was kept, and with none between given from
/// the store, the route's requests are its handler's, as they were before the app kept
/// bodies, but about one in 256, drawn on each thread, which asks as before and so finds out
/// a route whose bodies grew. Most often each was too small; an answer left out for another
/// reason (a failure, a submit key, a lifetime of nothing) counts the same, since asking for
/// it gained as little. A route that answers some of each keeps asking while an answer kept or
/// given comes within each [`UNKEPT_RUN`]: one kept ends the run, and so does one given from
/// the store, since once a route's large bodies are kept the only ones still made are the
/// small. Without one (64 failures in a row from a route with bodies kept, too) it leaves,
/// until the request that asks is one for a body kept or worth keeping. While a route leaves the store out, a body it kept
/// earlier is not given, but to the request that asks: it is made again, as it would be had it
/// not been kept, and the kept one may be given after it, while its lifetime lasts.
///
/// The count has a cache line to itself: every request to the route reads it, and a request
/// that finds nothing kept writes the counts of the `Arc` that holds it.
#[derive(Default)]
#[repr(align(64))]
pub(crate) struct Unkept(AtomicU8);

impl Unkept {
    /// Whether this request is the handler's without the store being asked.
    #[inline]
    pub(crate) fn leaves(&self) -> bool {
        if self.0.load(Ordering::Relaxed) < UNKEPT_RUN {
            return false;
        }
        // Drawn, not counted: a count of the thread's requests comes round in step with clients
        // that ask in a pattern, and one route of two would then never be the one that asks.
        DRAWN.with(|drawn| {
            let next = draw(drawn.get());
            drawn.set(next);
            next >> 24 != 0
        })
    }

    /// The route's request was given a kept body: the route has bodies worth asking for.
    #[inline]
    pub(crate) fn found(&self) {
        self.made(true);
    }

    /// The route made an answer for a request that found nothing kept, and it was kept or not.
    fn made(&self, kept: bool) {
        let run = self.0.load(Ordering::Relaxed);
        if kept {
            if run != 0 {
                self.0.store(0, Ordering::Relaxed);
            }
        } else {
            self.counted(run);
        }
    }

    /// One more answer not kept, after a run read as `run`. Counted from that run alone: where
    /// an answer was kept or given since it was read, the run it ended stays ended. Two
    /// requests at once may count as one.
    fn counted(&self, run: u8) {
        if run < UNKEPT_RUN {
            let _ = self.0.compare_exchange(run, run + 1, Ordering::Relaxed, Ordering::Relaxed);
        }
    }

    /// How many requests of a route that left the store out this thread leaves to their
    /// handlers before one asks, set to `left` for a test that counts them.
    #[cfg(test)]
    pub(crate) fn leaves_next(left: usize) {
        while Self::left_before_one_asks() != left {
            DRAWN.set(draw(DRAWN.get()));
        }
    }

    /// How many requests this thread leaves before one asks, as its draws stand.
    #[cfg(test)]
    fn left_before_one_asks() -> usize {
        let mut next = draw(DRAWN.get());
        let mut left = 0;
        while next >> 24 != 0 {
            next = draw(next);
            left += 1;
        }
        left
    }
}

/// The draw after `last` (xorshift, Marsaglia 2003): every number but zero comes round once
/// before any comes twice, and its top byte is zero for one in 256 of them.
#[inline]
fn draw(mut last: u32) -> u32 {
    last ^= last << 13;
    last ^= last >> 17;
    last ^= last << 5;
    last
}

/// What became of one request that found nothing kept, told to its route when this goes: its
/// answer was kept, or it was not, whatever the reason and also where the handler never
/// answered. A request for a URL not asked for before in a full store has none
/// ([`Asked::missed`]): what was refused there is the URL, before any answer, and counting it
/// would let a walk over new URLs make a route leave that has bodies kept.
struct Told(Option<Arc<Unkept>>, bool);

impl Drop for Told {
    fn drop(&mut self) {
        if let Some(route) = &self.0 {
            route.made(self.1);
        }
    }
}

/// The least bytes of a whole body the app keeps. Kept, a body saves its handler, its writing,
/// its compression where the app compresses it, and the hash of its tag, which is made for every
/// request that names a coding, as a browser's does, whether or not the body is compressed
/// (docs/design.md#limit-etag). The hash grows with the body and the instructions asking the store
/// costs do not, so a small body is left to its handler (docs/design.md#choice-kept-pages has
/// what was measured at this size). It is also the size the app compresses from.
const BODY_FROM: u64 = 1024;

// One size in the guide for both: a build in which they differ does not compile.
#[cfg(feature = "compress")]
const _: () = assert!(BODY_FROM == crate::compress::MIN_SIZE);

/// How many words of marks ([`Store::asked`]) a store of `bound` bytes has, made when it first
/// fills: a mark is one bit, and there is one for every 32 bytes of the bound, rounded up to a
/// power of two of words. That is 1,048,576 marks in 128 KiB for the 32 MiB an app keeps unless
/// it says otherwise, a hundred and more for each page of a few thousand bytes it has room for.
fn marks_for(bound: usize) -> usize {
    (bound / 2048).max(1).next_power_of_two()
}

/// The app's kept answers, at most `bound` bytes of them.
pub(crate) struct Answers(Arc<Store>);

struct Store {
    bound: usize,
    /// The bytes kept: every entry's size, with what was made for it since it was kept.
    bytes: AtomicUsize,
    /// The writes, counted by path ([`Written`]): a page stands only while the count is the one
    /// its request found before its handler ran. So a write drops every page at its path,
    /// whatever its query, and a page whose handler was reading while the write was made is not
    /// kept, without a lock or a search.
    written: OnceLock<Box<[AtomicU32]>>,
    /// The writes that found no counts to count in ([`Answers::writing`]), all together: none
    /// are made until an answer that may be kept is ([`Missed::keep`]), so an app that keeps
    /// nothing pays for no count by path. An answer stands only while this is as its request
    /// found it too, so such a write that ends after an answer was kept drops it, and every
    /// other one: only the writes under way when the counts are made, and work they left,
    /// can.
    early: AtomicU32,
    /// One bit for each mark of a URL asked for since the store filled ([`Store::asked`]).
    marks: OnceLock<Box<[AtomicU64]>>,
    /// How many of the marks are set.
    marked: AtomicUsize,
    /// The keys of its hash of a URL, the process's own, so a client cannot choose URLs that share
    /// a place in its table.
    keys: RandomState,
    inner: RwLock<Inner>,
}

/// Which of the store's counts is a path's: by a hash of the path with its escapes decoded
/// ([`crate::page::path_hash`]), so `/a%7Eb` and `/a~b` are one page's. Two paths may share a
/// count, and then a write to either drops the other's pages early.
fn count_of(path: &[u8]) -> usize {
    (crate::page::path_hash(path) >> 32) as usize % WRITES
}

/// The hasher of the store's table, whose keys are hashes already: a request's URL is hashed once,
/// by the store's keys ([`Asked::of`]), and not again for each lookup.
#[derive(Default)]
struct Prehashed(u64);

impl Hasher for Prehashed {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write_u64(&mut self, hash: u64) {
        self.0 = hash;
    }

    /// Not called for a `u64`.
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = self.0.rotate_left(8) ^ u64::from(byte);
        }
    }
}

/// A path's count of writes, as a request found it.
#[derive(Clone, Copy)]
struct Written {
    count: usize,
    was: u32,
    /// [`Store::early`] as the request found it.
    early: u32,
}

impl Written {
    /// The count for `at` (a path, with or without a query) as it is now: 0 while there are no
    /// counts, which start at 0 when they are made. The writes that find none are read first,
    /// so one that ends after this is seen whichever it turns out to be.
    fn of(store: &Store, at: &str) -> Self {
        let count = count_of(at.split(['?', '#']).next().unwrap_or(at).as_bytes());
        let early = store.early.load(Ordering::Acquire);
        let was = store.written.get().map_or(0, |counts| counts[count].load(Ordering::Acquire));
        Written { count, was, early }
    }

    /// No write to the path since, and none that found no counts. With no counts yet, every
    /// write since was one of those.
    fn stands(self, store: &Store) -> bool {
        store.early.load(Ordering::Acquire) == self.early
            && store.written.get().is_none_or(|counts| counts[self.count].load(Ordering::Acquire) == self.was)
    }
}

/// A request that may change what its path shows (a method that is not safe), from before its
/// handler can start until it is answered or dropped: it is counted either way, for its path
/// or, where it found no counts by path, with the others like it.
pub(crate) struct Writing<'a> {
    answers: &'a Answers,
    /// The path's count and the request's `Host`; none for a write that found no counts to
    /// count in, which is counted with the others like it ([`Store::early`]).
    counted: Option<(usize, Option<HeaderValue>)>,
    answered: bool,
}

impl Writing<'_> {
    /// The write was answered: counts it for its path and for the places on this site its answer
    /// names (RFC 9111 section 4.4), so nothing kept there stands; one that found no counts by
    /// path is counted for every path at once. Its path counts whatever the
    /// answer: a handler that answered `4xx` or `5xx`, or passed its deadline (a `503`, or a
    /// `408` while it waited for the body), may have written first, and its status does not say
    /// (work it left under `Signal::finish` counts again when it ends). That holds for the
    /// router's own `404`, `405` and `501` too: a middleware met the request before the
    /// router answered it, and nothing here knows it wrote nothing. The places an answer names
    /// count only for a write that did not fail.
    pub(crate) fn answered(mut self, res: &Response) {
        self.answered = true;
        let Some((count, host)) = &self.counted else {
            // Whatever it wrote and wherever its answer points: nothing stands across it.
            self.answers.early();
            return;
        };
        self.answers.count(*count);
        if res.status().is_client_error() || res.status().is_server_error() {
            return;
        }
        for name in [header::LOCATION, header::CONTENT_LOCATION, crate::page::LOCATION_HEADER] {
            let to = res.headers().get(name).and_then(|to| on_site(to.as_bytes(), host.as_ref()));
            if let Some(path) = to {
                self.answers.count(count_of(path));
            }
        }
    }
}

impl Drop for Writing<'_> {
    /// Dropped before its answer (the client left): what its handler wrote by then is written.
    fn drop(&mut self) {
        if !self.answered {
            match &self.counted {
                Some((count, _)) => self.answers.count(*count),
                None => self.answers.early(),
            }
        }
    }
}

/// The path of a place on this site that `to` (a `Location`) names: one that starts at the
/// root, or a whole URL with the request's `Host`. Another site's page is not kept here, and a
/// reference relative to the request's path is not followed.
fn on_site<'a>(to: &'a [u8], host: Option<&HeaderValue>) -> Option<&'a [u8]> {
    let path = |rest: &'a [u8]| rest.split(|byte| matches!(byte, b'?' | b'#')).next().unwrap_or(rest);
    let schemes: [&[u8]; 3] = [b"https://", b"http://", b"//"];
    let named = schemes.iter().find_map(|scheme| {
        let start = to.get(..scheme.len()).filter(|start| start.eq_ignore_ascii_case(scheme))?;
        Some(&to[start.len()..])
    });
    match named {
        Some(rest) => {
            let end = rest.iter().position(|byte| matches!(byte, b'/' | b'?' | b'#')).unwrap_or(rest.len());
            let (authority, rest) = rest.split_at(end);
            host.filter(|host| host.as_bytes().eq_ignore_ascii_case(authority)).map(|_| match rest.first() {
                Some(b'/') => path(rest),
                _ => &b"/"[..],
            })
        }
        None => to.starts_with(b"/").then(|| path(to)),
    }
}

/// Where an entry is kept.
struct Place {
    /// In the clock's slots.
    slot: usize,
    /// The store, to count what is made for the entry later and make room for that.
    #[cfg(feature = "compress")]
    store: Weak<Store>,
}

#[derive(Default)]
struct Inner {
    /// By the hash of their path and query ([`Prehashed`]), the copies for each `Host`,
    /// `Accept-Language` and way of asking: each holds its URL, as two URLs may share a hash.
    at: HashMap<u64, Vec<Arc<Entry>>, BuildHasherDefault<Prehashed>>,
    /// Every entry, in the place the clock's hand finds it: one not used since the hand last
    /// passed is the next to go when the bound is passed.
    slots: Vec<Option<Arc<Entry>>>,
    free: Vec<usize>,
    hand: usize,
}

/// What a copy is kept for, in one allocation: its URL (the path and query), the `Host` it was
/// asked with and, when its `Vary` names the header, the `Accept-Language`, as they were sent. A
/// copy of its own, made once the answer is to be kept: a request's URL and header values are
/// slices of the connection's read buffer, which a kept one would hold whole. A miss that is not
/// kept never builds it; until then the request's URL and header values are held by handles that
/// copy none of their bytes, though the first clone of a header a middleware made for itself may
/// allocate the count of its holders.
struct Key {
    /// The URL, then the `Host` and the `Accept-Language` that were sent.
    bytes: Box<[u8]>,
    /// Where the URL ends.
    at: usize,
    /// Where the `Host` ends, if one was sent.
    host: Option<usize>,
    /// Where the `Accept-Language` ends, if one was sent.
    language: Option<usize>,
}

impl Key {
    /// The bytes a key of these holds.
    fn length(at: &str, host: Option<&HeaderValue>, language: Option<&HeaderValue>) -> usize {
        at.len() + host.map_or(0, HeaderValue::len) + language.map_or(0, HeaderValue::len)
    }

    fn new(at: &str, host: Option<&HeaderValue>, language: Option<&HeaderValue>) -> Self {
        let mut bytes = Vec::with_capacity(Key::length(at, host, language));
        let (host, language) = (host.map(HeaderValue::as_bytes), language.map(HeaderValue::as_bytes));
        bytes.extend_from_slice(at.as_bytes());
        let mut end = |sent: &[u8]| {
            bytes.extend_from_slice(sent);
            bytes.len()
        };
        let (host, language) = (host.map(&mut end), language.map(&mut end));
        Key { bytes: bytes.into_boxed_slice(), at: at.len(), host, language }
    }

    fn at(&self) -> &[u8] {
        &self.bytes[..self.at]
    }

    fn host(&self) -> Option<&[u8]> {
        self.host.map(|end| &self.bytes[self.at..end])
    }

    fn language(&self) -> Option<&[u8]> {
        self.language.map(|end| &self.bytes[self.host.unwrap_or(self.at)..end])
    }
}

/// One kept answer, as its handler gave it.
pub(crate) struct Entry {
    key: Key,
    /// Its URL's hash, its key in the store's table.
    hash: u64,
    place: Place,
    written: Written,
    /// Whether its `Vary` names `Accept-Language` (as it does once its handler read the language
    /// the header asks for), so the one it was asked with is part of its key.
    by_language: bool,
    /// Asked for as data (`Accept: application/json` first): what [`Mode`] its handler saw.
    data: bool,
    made: Instant,
    /// Its lifetime, in seconds.
    lifetime: u64,
    head: Head,
    /// How many names `head` has, each counted once: what its map is made with room for
    /// ([`with_room`]). At most [`NAMES`].
    names: u16,
    cache: crate::cache::Typed,
    style: Option<crate::security::StyleBlock>,
    body: Bytes,
    /// The tag's hasher once it has read the body ([`crate::cache::tag`]).
    hashed: OnceLock<DefaultHasher>,
    /// The body in each coding, once a request asked for it.
    #[cfg(feature = "compress")]
    coded: [OnceLock<Bytes>; 3],
    used: AtomicBool,
    /// What it counts for in the store's bytes, or [`GONE`].
    size: AtomicUsize,
}

/// On a response whose body is a kept answer's: the stages after the handler find the body's
/// hash and its compressed forms here while the body is still those bytes, as a held value's are
/// found (`compress::Stored`). A middleware that replaced the body keeps the extension, not the
/// bytes it stood for.
#[derive(Clone)]
pub(crate) struct Kept(Arc<Entry>);

impl Kept {
    /// The cache's mark of the kept answer these are the extensions of, which its handler's
    /// answer carried as an extension of its own (`crate::cache::Typed`).
    pub(crate) fn typed(extensions: &http::Extensions) -> Option<crate::cache::Typed> {
        extensions.get::<Kept>().map(|Kept(entry)| entry.cache)
    }

    fn of<'a>(extensions: &'a http::Extensions, body: &Bytes) -> Option<&'a Entry> {
        let Kept(entry) = extensions.get::<Kept>()?;
        (entry.body.as_ptr() == body.as_ptr() && entry.body.len() == body.len()).then_some(&**entry)
    }

    /// The tag's hasher with `body` read, which `start` makes: kept with the answer `body` is
    /// from, so only its first tag reads the body.
    pub(crate) fn hashed<S: BuildHasher<Hasher = DefaultHasher>>(
        extensions: &http::Extensions,
        body: &Bytes,
        key: &S,
    ) -> DefaultHasher {
        let start = || {
            let mut hasher = key.build_hasher();
            // Its length first, so no body and headers read as another body and fewer headers.
            hasher.write_usize(body.len());
            hasher.write(body);
            hasher
        };
        match Kept::of(extensions, body) {
            Some(entry) => entry.hashed.get_or_init(start).clone(),
            None => start(),
        }
    }

    /// `body` in `coding`, which `encode` makes: kept with the answer `body` is from, so only the
    /// first request for a coding compresses it.
    #[cfg(feature = "compress")]
    pub(crate) fn coded(
        extensions: &http::Extensions,
        body: &Bytes,
        coding: crate::compress::Coding,
        encode: impl FnOnce() -> Bytes,
    ) -> Bytes {
        let Some(entry) = Kept::of(extensions, body) else { return encode() };
        let slot = &entry.coded[coding as usize];
        if let Some(coded) = slot.get() {
            return coded.clone();
        }
        // Made outside the cell: two first requests each compress it, and neither waits.
        // A copy of its own length: an encoder's buffer is sized for the worst case, and the
        // bytes made from it hold all of that for as long as they are kept.
        let coded = Bytes::copy_from_slice(&encode());
        if slot.set(coded.clone()).is_ok() {
            entry.grew(coded.len());
        }
        coded
    }
}

impl Entry {
    /// Counts `more` bytes made for it, unless it is no longer kept, and makes room for them when
    /// they take the store past its bound, as keeping a page does.
    #[cfg(feature = "compress")]
    fn grew(&self, more: usize) {
        let Some(store) = self.place.store.upgrade() else { return };
        // Added first and taken back if it is gone, so the total never falls below what the
        // entries count for.
        store.bytes.fetch_add(more, Ordering::AcqRel);
        let mut now = self.size.load(Ordering::Acquire);
        loop {
            if now == GONE {
                store.bytes.fetch_sub(more, Ordering::AcqRel);
                return;
            }
            match self.size.compare_exchange_weak(now, now + more, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => break,
                Err(actual) => now = actual,
            }
        }
        if store.bytes.load(Ordering::Acquire) > store.bound {
            let mut inner = store.inner.write().unwrap_or_else(PoisonError::into_inner);
            store.make_room(&mut inner, self);
        }
    }

    /// Its age in seconds, which its lifetime is counted in.
    fn age(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.made).as_secs()
    }

    /// Within its lifetime, with no write to its path since its handler read.
    fn stands(&self, store: &Store, now: Instant) -> bool {
        self.age(now) < self.lifetime && self.written.stands(store)
    }

    /// The `Accept-Language` it was asked with, when its `Vary` names the header.
    fn language(&self) -> Option<Option<&[u8]>> {
        self.by_language.then(|| self.key.language())
    }

    fn is_for(&self, host: Option<&HeaderValue>, language: Option<&HeaderValue>, data: bool) -> bool {
        self.data == data
            && self.key.host() == host.map(HeaderValue::as_bytes)
            && self.language().is_none_or(|kept| kept == language.map(HeaderValue::as_bytes))
    }
}

impl Store {
    /// Whether keeping an answer may have to drop a page: the bytes kept are within the largest
    /// answer that is kept ([`SHARE`]) of the bound. The pages that no longer stand count too,
    /// since most stay until room is made: a store that filled once is seldom not full again,
    /// and when it is, answers are kept the first time until it fills.
    fn full(&self) -> bool {
        self.bytes.load(Ordering::Relaxed) > self.bound - self.bound / SHARE
    }

    /// Whether the URL `at` (a path and query), asked for with `host` in any language, was asked
    /// for before by a request no kept answer stood for, in a full store, since the marks were
    /// last cleared; and marks it.
    ///
    /// A mark is one bit, found by a hash of the URL, and no other URL unsets it. So a URL
    /// asked for before is known, and one not asked for before is taken for known when its
    /// bit is another's: its answer is then kept the first time, as every answer is while the
    /// store has room. Once an eighth of the marks are set they are all cleared, which holds
    /// that to one new URL in eight at most, and costs each page that is asked for again after
    /// its kept copy has gone one more run of its handler.
    ///
    /// The hash has no key of the process's. A client that chooses URLs sharing a mark gains
    /// an answer kept the first time, and one that asks for enough new URLs to clear the marks
    /// gains that one more run for each page, with requests that each ran a handler.
    fn asked(&self, host: Option<&HeaderValue>, at: &str) -> bool {
        let marks = self.marks.get_or_init(|| (0..marks_for(self.bound)).map(|_| AtomicU64::new(0)).collect());
        let hash = BuildHasherDefault::<DefaultHasher>::default().hash_one((host.map(HeaderValue::as_bytes), at));
        let (word, bit) = (&marks[(hash >> 6) as usize % marks.len()], 1 << (hash & 63));
        if word.fetch_or(bit, Ordering::Relaxed) & bit != 0 {
            return true;
        }
        // 64 marks a word, so this is an eighth of them. The URL that clears them is unmarked
        // with the rest, and requests that get here at once may each clear or count one too
        // many: a URL is then asked for once more than it had to be.
        if self.marked.fetch_add(1, Ordering::Relaxed) >= marks.len() * 8 {
            marks.iter().for_each(|word| word.store(0, Ordering::Relaxed));
            self.marked.store(0, Ordering::Relaxed);
        }
        false
    }

    /// Takes `entry` out of its slot and its URL's copies, and its size out of the bytes kept.
    fn drop_entry(&self, inner: &mut Inner, entry: &Arc<Entry>) {
        let slot = entry.place.slot;
        if inner.slots.get(slot).and_then(Option::as_ref).is_some_and(|held| Arc::ptr_eq(held, entry)) {
            inner.slots[slot] = None;
            inner.free.push(slot);
        }
        if let Some(copies) = inner.at.get_mut(&entry.hash) {
            copies.retain(|copy| !Arc::ptr_eq(copy, entry));
            if copies.is_empty() {
                inner.at.remove(&entry.hash);
            }
        }
        let size = entry.size.swap(GONE, Ordering::AcqRel);
        if size != GONE {
            self.bytes.fetch_sub(size, Ordering::AcqRel);
        }
    }

    /// Drops entries until the bound holds: one that no longer stands (past its lifetime, or
    /// written to since), or not used since the hand last passed it, as the hand comes to it.
    /// Never `kept`, the one room is made for.
    fn make_room(&self, inner: &mut Inner, kept: &Entry) {
        let now = Instant::now();
        // Twice around: the first pass clears every mark, so the second finds one to drop.
        let mut steps = inner.slots.len() * 2;
        while self.bytes.load(Ordering::Acquire) > self.bound && steps > 0 {
            steps -= 1;
            inner.hand = (inner.hand + 1) % inner.slots.len();
            let Some(entry) = inner.slots[inner.hand].clone() else { continue };
            if std::ptr::eq(&*entry, kept) {
                continue;
            }
            if entry.stands(self, now) && entry.used.swap(false, Ordering::Relaxed) {
                continue;
            }
            self.drop_entry(inner, &entry);
        }
    }
}

impl Answers {
    /// Room for `bound` bytes of answers; none for a bound of 0.
    pub(crate) fn new(bound: usize) -> Option<Self> {
        (bound > 0).then(|| {
            Answers(Arc::new(Store {
                bound,
                bytes: AtomicUsize::new(0),
                written: OnceLock::new(),
                early: AtomicU32::new(0),
                marks: OnceLock::new(),
                marked: AtomicUsize::new(0),
                keys: RandomState::new(),
                inner: RwLock::default(),
            }))
        })
    }

    /// The bytes kept now.
    #[cfg(test)]
    pub(crate) fn bytes(&self) -> usize {
        self.0.bytes.load(Ordering::Acquire)
    }

    /// [`Answers::found`], for a test.
    #[cfg(test)]
    fn find(
        &self,
        at: &str,
        host: Option<&HeaderValue>,
        language: Option<&HeaderValue>,
        data: bool,
    ) -> Option<(Arc<Entry>, u64)> {
        self.found(self.0.keys.hash_one(at), at, host, language, data)
    }

    /// The answer kept for a request for `at`, whose hash by the store's keys is `hash`, while it
    /// stands, with its age in seconds.
    fn found(
        &self,
        hash: u64,
        at: &str,
        host: Option<&HeaderValue>,
        language: Option<&HeaderValue>,
        data: bool,
    ) -> Option<(Arc<Entry>, u64)> {
        let inner = self.0.inner.read().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        // The copy that stands: one that no longer does is in no other's way until it goes.
        let entry =
            inner.at.get(&hash)?.iter().find(|entry| {
                entry.key.at() == at.as_bytes() && entry.is_for(host, language, data) && entry.stands(&self.0, now)
            })?;
        let age = entry.age(now);
        // Stored only when it changes: a page read often is marked once for each pass of the hand.
        if !entry.used.load(Ordering::Relaxed) {
            entry.used.store(true, Ordering::Relaxed);
        }
        Some((entry.clone(), age))
    }

    /// Keeps `entry`, in the place of the copy it stands for, and makes room for it.
    fn keep(&self, make: impl FnOnce(Place) -> Entry) -> Arc<Entry> {
        let store = &*self.0;
        let mut inner = store.inner.write().unwrap_or_else(PoisonError::into_inner);
        let slot = inner.free.pop().unwrap_or(inner.slots.len());
        let entry = Arc::new(make(Place {
            slot,
            #[cfg(feature = "compress")]
            store: Arc::downgrade(&self.0),
        }));
        let now = Instant::now();
        let copies = inner.at.get(&entry.hash).map(Vec::as_slice).unwrap_or_default();
        // The copies this one takes the place of: the one asked the same way, and those that no
        // longer stand. With none of either in a full set, the oldest not read since it was kept
        // (or since the hand passed it), so a way of asking seen once does not take the place of
        // one seen often; else the oldest.
        let mut copies = copies.iter().filter(|copy| copy.key.at() == entry.key.at());
        let mut replaced: Vec<_> = copies
            .clone()
            .filter(|copy| {
                (copy.key.host() == entry.key.host() && copy.language() == entry.language() && copy.data == entry.data)
                    || !copy.stands(store, now)
            })
            .cloned()
            .collect();
        if replaced.is_empty() && copies.clone().count() >= COPIES {
            let unread = copies.clone().find(|copy| !copy.used.load(Ordering::Relaxed));
            replaced.extend(unread.or_else(|| copies.next()).cloned());
        }
        for replaced in &replaced {
            store.drop_entry(&mut inner, replaced);
        }
        if slot == inner.slots.len() {
            inner.slots.push(None);
        }
        inner.slots[slot] = Some(entry.clone());
        // Room for this copy alone: most URLs are kept for one `Host` and one way of asking, and
        // a list made by `push` has room for four, 32 bytes of jemalloc's where this takes 8.
        inner.at.entry(entry.hash).or_insert_with(|| Vec::with_capacity(1)).push(entry.clone());
        store.bytes.fetch_add(entry.size.load(Ordering::Acquire), Ordering::AcqRel);
        store.make_room(&mut inner, &entry);
        entry
    }

    /// A request that may change what its path shows is about to reach its handler. `signal` is
    /// told which count is the path's, for work that outlives the request ([`crate::Signal::finish`]).
    ///
    /// With no counts yet (no answer that may be kept was made), nothing of the path is read:
    /// the write is counted with the others like it when it ends.
    pub(crate) fn writing(&self, req: &Request, signal: &crate::Signal) -> Writing<'_> {
        if self.0.written.get().is_none() {
            signal.writes_early();
            return Writing { answers: self, counted: None, answered: false };
        }
        let count = count_of(req.uri().path().as_bytes());
        signal.writes(count);
        Writing { answers: self, counted: Some((count, req.headers().get(header::HOST).cloned())), answered: false }
    }

    /// Counts a write to the paths `count` is for, so no page kept for them stands: every
    /// query's (a named post is `?do=name` at its page's path) and one whose handler has yet to
    /// answer.
    pub(crate) fn count(&self, count: usize) {
        // Only a write that found the counts has one to name.
        if let Some(counts) = self.0.written.get() {
            counts[count].fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Counts a write that found no counts when it began ([`Store::early`]), or work it left
    /// that has ended: no answer made or kept across it stands.
    pub(crate) fn early(&self) {
        self.0.early.fetch_add(1, Ordering::AcqRel);
    }

    /// The counts of writes by path, made by the first answer that may be kept, kept or not: a
    /// write that began before them is counted with the others like it, and one after, by path.
    fn counts(&self) {
        self.0.written.get_or_init(|| (0..WRITES).map(|_| AtomicU32::new(0)).collect());
    }
}

/// A request a kept answer can stand for: a `GET` that shows nothing about who is asking, for
/// the whole document where the route answers a page, read as the handler would see it (after
/// the app's middleware).
pub(crate) struct Asked<'a> {
    answers: &'a Answers,
    signal: &'a crate::Signal,
    at: &'a PathAndQuery,
    /// `at`'s hash, by the store's keys.
    hash: u64,
    host: Option<&'a HeaderValue>,
    language: Option<&'a HeaderValue>,
    data: bool,
}

/// What a request's headers say of whether a kept answer can stand for it, and what of them its
/// key is made of.
struct Sent<'a> {
    host: Option<&'a HeaderValue>,
    language: Option<&'a HeaderValue>,
    /// A data client asks: a whole body is kept for it apart from the one a browser is given.
    data: bool,
}

impl<'a> Sent<'a> {
    /// `None` where the headers show something the answer could differ by beside its key: a
    /// cookie but the time zone's, an `Authorization`, what the runtime asks for (`corten`,
    /// whatever it says), a notice the page sends back when it is read again, where a stream
    /// stopped, a body; and, of a page, a data client's JSON asked for first, which is another
    /// answer at the same URL. A whole body is its route's one answer, so a data client's
    /// request is kept too, apart: a handler that takes `Req` can read which of the two asked
    /// (`req.mode`).
    // `TELL` is [`Asked::checked`]'s: `corten dev`'s reading is its own copy, closures and all, so
    // the one a release build runs has `Asked::of` as its only caller, and is made as it was then.
    fn read<const TELL: bool>(headers: &'a HeaderMap, shape: Shape) -> Option<Self> {
        // By their names and first, since they are what most requests a page is not kept for
        // carry: a session's cookie, and the runtime's header on a navigation inside the app.
        // Each is a lookup of about 100 instructions that the pass below could make in its
        // stride, and is not: found there, after a browser's other headers, an `Authorization`
        // cost its request 611 more to spare every other one that lookup
        // (docs/design.md#choice-kept-pages).
        if crate::cache::Credentials::read(headers).personal(|| headers.contains_key(header::AUTHORIZATION))
            || headers.contains_key(crate::page::MODE_HEADER)
        {
            return None;
        }
        // The rest in one pass over the headers, where each would be a lookup by its name.
        let (mut host, mut language, mut data) = (None, None, None);
        // Who asks, by the rule for a request's mode ([`Mode::said`]) with no `corten` header,
        // as none was found above: a browser for the document, or a data client where the route
        // answers a whole body.
        let asks = |accept: Option<&'a HeaderValue>| match (Mode::said(None, || accept).0, shape) {
            ((Mode::Document, false), _) => Some(false),
            ((Mode::Data, false), Shape::Body) => Some(true),
            _ => None,
        };
        for (name, value) in headers {
            // The first line of each, which is what a lookup gives.
            if name == header::HOST {
                host = host.or(Some(value));
            } else if name == header::ACCEPT {
                // A request no kept answer stands for leaves here, as it left before the rest
                // was read.
                if data.is_none() {
                    data = Some(asks(Some(value))?);
                }
            } else if name == header::ACCEPT_LANGUAGE {
                language = language.or(Some(value));
            } else if name == header::CONTENT_LENGTH
                || name == header::TRANSFER_ENCODING
                || *name == NOTICE
                || *name == LAST_EVENT_ID
            {
                return None;
            }
        }
        let data = match data {
            Some(data) => data,
            None => asks(None)?,
        };
        Some(Sent { host, language, data })
    }
}

impl<'a> Asked<'a> {
    pub(crate) fn of(req: &'a Request, shape: Shape) -> Option<Self> {
        Self::checked::<false>(req, shape).ok()
    }

    /// [`Asked::of`], with, when `TELL` (`corten dev`, before the handler runs: [`Verdict`]), the
    /// reason a request the store would otherwise be asked for is not: `Err(Some(_))` for one the
    /// page's author can change (an app that keeps no answers among them), `Err(None)` for what
    /// the request alone decides (a cookie, a navigation, a proxy's URL), which is not said. A
    /// release build reads none of it: with `TELL` false every `Err` is `None`, and this is the
    /// code `of` always was.
    #[inline(always)]
    pub(crate) fn checked<const TELL: bool>(req: &'a Request, shape: Shape) -> Result<Self, Option<Verdict>> {
        if *req.method() != http::Method::GET {
            return Err(None);
        }
        let signal = req.extensions().get::<crate::Signal>().ok_or(None)?;
        let answers = signal.shared().and_then(|shared| shared.kept.as_ref());
        // An app that keeps no answers asks nothing more. Under `corten dev` that is said, below,
        // only of a request the store would otherwise be asked for, as every reason is.
        if !TELL && answers.is_none() {
            return Err(None);
        }
        // A caller a middleware read makes the answer that caller's, and the error page's request
        // is not the one the route would answer. Said of a request the store would otherwise ask
        // for, below: one with a session's cookie is left to its handler anyway.
        if (signal.is_personal() && !TELL) || signal.is_error_page() {
            return Err(None);
        }
        let Sent { host, language, data } = Sent::read::<TELL>(req.headers(), shape).ok_or(None)?;
        // In origin form: a URL that names its own host is a proxy's.
        if req.uri().authority().is_some() {
            return Err(None);
        }
        // An app with a route that keeps an answer has a store unless its bound is 0.
        let Some(answers) = answers else {
            return Err(if TELL && signal.shared().is_some() { Some(Verdict::Off) } else { None });
        };
        if TELL && signal.is_personal() {
            return Err(Some(Verdict::Caller));
        }
        let at = req.uri().path_and_query().ok_or(None)?;
        // The URL the router matched: a route's parameters are read from the path as it was then
        // ([`crate::router::MatchedPath`]), so after a middleware changed the URI, the one the
        // handler sees no longer names the page it makes.
        let matched = req.extensions().get::<crate::router::MatchedPath>();
        if matched.is_none_or(|matched| matched.matched() != at) {
            return Err(if TELL && matched.is_some() { Some(Verdict::Rewritten) } else { None });
        }
        let hash = answers.0.keys.hash_one(at.as_str());
        Ok(Asked { answers, signal, at, hash, host, language, data })
    }

    /// The kept answer for this request, as its handler gave it, with its age.
    pub(crate) fn find(&self) -> Option<Response> {
        let (entry, age) = self.answers.found(self.hash, self.at.as_str(), self.host, self.language, self.data)?;
        // Kept for the language it was asked in: the answer names `Accept-Language` as it leaves
        // the app, whatever `Vary` a middleware puts on it after this (`crate::page::vary_on_language`).
        if entry.by_language {
            self.signal.ask_language();
        }
        let mut res = Response::new(Body::from(entry.body.clone()));
        let mut head = with_room(&entry.head, entry.names.into());
        // So a cache after this one, the browser's too, does not start the lifetime over.
        head.insert(header::AGE, age_value(age));
        *res.headers_mut() = head;
        // The cache's mark is the entry's ([`Kept::typed`]): an extension is an allocation and
        // a place in the map, and this answer has one for the entry already.
        let extensions = res.extensions_mut();
        if let Some(style) = &entry.style {
            extensions.insert(style.clone());
        }
        extensions.insert(Kept(entry));
        Some(res)
    }

    /// What keeping the handler's answer needs of the request, once no kept one stood for it:
    /// taken before the handler runs, so the answer's age counts its making and a write made
    /// meanwhile is seen. None in a full store for a URL not asked for before: keeping its
    /// answer would drop a page for one no one is known to ask for again, so the answer is the
    /// handler's and nothing here is paid for it but the mark it leaves.
    pub(crate) fn missed(&self, req: &Request, route: Option<Arc<Unkept>>) -> Option<Missed> {
        let store = &*self.answers.0;
        if store.full() && !store.asked(self.host, self.at.as_str()) {
            return None;
        }
        Some(Missed {
            asked: Instant::now(),
            written: Written::of(&self.answers.0, self.at.as_str()),
            signal: req.extensions().get::<crate::Signal>().cloned(),
            nonce: req.extensions().get::<crate::security::NonceSlot>().cloned(),
            at: self.at.clone(),
            host: self.host.cloned(),
            language: self.language.cloned(),
            hash: self.hash,
            data: self.data,
            told: Told(route, false),
        })
    }
}

/// A request no kept answer stood for, whose handler's answer is kept if it may be.
pub(crate) struct Missed {
    asked: Instant,
    written: Written,
    signal: Option<crate::Signal>,
    nonce: Option<crate::security::NonceSlot>,
    /// The URL, `Host` and `Accept-Language` it was asked with, sharing the request's bytes until
    /// its answer is kept: its [`Key`] is copied from them then, with the `Accept-Language` only
    /// when the answer varies on it, so a header the page does not read is neither held nor
    /// counted.
    at: PathAndQuery,
    host: Option<HeaderValue>,
    language: Option<HeaderValue>,
    hash: u64,
    data: bool,
    /// Of a route of whole bodies, which is told whether this request's answer was kept.
    told: Told,
}

impl Missed {
    /// Under `corten dev`: its handler drew a form's new submit key, so a release build gives the
    /// answer as it is, before [`Missed::keep`] ([`Verdict::DrewKey`]).
    #[cold]
    pub(crate) fn drew_key(&self) {
        if let Some(signal) = &self.signal {
            Verdict::DrewKey.found(signal);
        }
    }

    /// `res`, kept when it is the same for everyone and for how long: see the module. `TELL` is
    /// `corten dev`'s copy (`crate::router::Telling`): nothing is kept, and the request is given
    /// what a release build does with its answer instead ([`Verdict`]), with the answer's head
    /// left as it is; one a release build would keep is left where that build reads its body,
    /// for [`tell_read`]. A release build's copy, with `TELL` false, is the code it was, but
    /// for the head's count ([`head_bytes`]).
    pub(crate) async fn keep<const TELL: bool>(mut self, mut res: Response) -> Response {
        let Some(signal) = &self.signal else { return res };
        let Some(answers) = signal.shared().and_then(|shared| shared.kept.as_ref()) else { return res };
        // Not kept: under `corten dev` the reason is made for the route to say.
        macro_rules! unkept {
            ($verdict:expr) => {{
                if TELL {
                    $verdict.found(signal);
                }
                return res;
            }};
        }
        // A form's new submit key the handler rendered where its watch did not poll (`req.rendered`
        // in a blocking task) marks only the request's signal, not the answer: it is this request's
        // alone too, and goes out as one (`crate::cache::Unrepeatable`).
        if signal.key_drawn() {
            unkept!(Verdict::DrewKey);
        }
        let Some((cache, lifetime)) = crate::cache::Typed::shared(&res) else {
            unkept!(Verdict::NoLifetime { status: res.status().as_u16() })
        };
        // Whether the page varies on `Accept-Language` (`App::messages`, or a locale negotiated
        // from it), or on something the key does not cover.
        let Some(mut language) = varies(res.headers()) else { unkept!(Verdict::Varies) };
        // A locale negotiated after the page set its headers is named now, so the key below
        // and the header the app sends agree. Under `corten dev` the answer is left as it is (the
        // app names it as the answer leaves, after its middleware, as it did with no store), and
        // its head is counted as a release build counts it, from a copy named so ([`NamedHead`]).
        if !language && signal.asked_language() {
            if TELL {
                let mut headers = res.headers().clone();
                crate::page::add_language(&mut headers);
                let _ = signal.found::<NamedHead>().set(NamedHead(headers.keys_len(), head_bytes(headers.iter())));
            } else {
                crate::page::add_language(res.headers_mut());
            }
            language = true;
        }
        let style = res.extensions().get::<crate::security::StyleBlock>().cloned();
        // Only what is put back on a kept answer: a mark this does not know is not replayed.
        let known = 2 + usize::from(style.is_some());
        if res.status() != StatusCode::OK {
            unkept!(Verdict::Status(res.status().as_u16()));
        }
        if res.extensions().len() != known || res.extensions().get::<crate::layout::SameForAll>().is_none() {
            unkept!(Verdict::Marked);
        }
        if res.headers().contains_key(header::SET_COOKIE) {
            unkept!(Verdict::SetsCookie);
        }
        if res.headers().contains_key(header::CONTENT_ENCODING) {
            unkept!(Verdict::Encoded);
        }
        if res.headers().contains_key(header::CONTENT_RANGE) {
            unkept!(Verdict::Range);
        }
        if res.headers().contains_key(header::ETAG) {
            unkept!(Verdict::Tagged);
        }
        if named_head::<TELL>(signal).map_or_else(|| res.headers().keys_len(), |(names, _)| names) > NAMES {
            unkept!(Verdict::Names);
        }
        if self.nonce.as_ref().is_some_and(|slot| slot.taken().is_some()) {
            unkept!(Verdict::Nonce);
        }
        if self.signal.as_ref().is_none_or(crate::Signal::is_personal) {
            unkept!(Verdict::Caller);
        }
        // Made over a time longer than it lasts: it would never be given.
        if self.asked.elapsed().as_secs() >= lifetime {
            unkept!(Verdict::Slow { took: self.asked.elapsed().as_secs(), lifetime });
        }
        let Some(length) = http_body::Body::size_hint(res.body()).exact() else { unkept!(Verdict::Unsized) };
        // A whole body is kept from a size, whatever its type.
        if self.told.0.is_some() && length < BODY_FROM {
            unkept!(Verdict::Small(length));
        }
        let head: usize = match named_head::<TELL>(signal) {
            Some((_, bytes)) => bytes,
            None => head_bytes(res.headers().iter()),
        };
        // The URL is held once, by the entry: the map holds its hash.
        let sent = self.language.as_ref().filter(|_| language);
        let size = Key::length(self.at.as_str(), self.host.as_ref(), sent) + head + OVERHEAD + length as usize;
        if length == 0 {
            unkept!(Verdict::Empty);
        }
        if size > answers.0.bound / SHARE {
            unkept!(Verdict::Large { size, bound: answers.0.bound });
        }
        // An answer that may be kept: writes are counted by path from here on, whether or not
        // this one is kept, so an app whose writes never pause still comes to keep its pages.
        answers.counts();
        // A write while the handler read: the page may show what was there before.
        if !self.written.stands(&answers.0) {
            unkept!(Verdict::Written);
        }
        // Under `corten dev` none is kept: the answer goes back to be said to be kept where a
        // release build keeps it, as its body is read ([`tell_read`]), and, of a route of whole
        // bodies, is told so, so it goes on asking.
        if TELL {
            self.told.1 = true;
            let _ = signal.found::<ToRead>().set(ToRead(lifetime));
            return res;
        }
        let (mut parts, body) = res.into_parts();
        // Exact size: one held `Bytes`.
        let body = match crate::body::to_bytes(body, usize::MAX).await {
            Ok(body) => body,
            // A body of an exact size that could not be read: not a page to send as it is. The
            // failure in its place is Corten's, not the handler's, so it is never shared whatever
            // the page said (the error page drawn for it may read the request's `Cookie`).
            Err(error) => {
                let error: &(dyn std::error::Error + 'static) = &*error;
                tracing::error!(error, "corten: a page to keep could not be read");
                let failed =
                    crate::response::IntoResponse::into_response(crate::Error::corten("corten: the page could not be read"));
                return crate::cache::unshared_in_place_of(&parts.extensions, failed);
            }
        };
        // A copy of its own length: a page's buffer is sized for the last page rendered and an
        // eighth more, and the bytes made from it would hold all of that for as long as they are
        // kept. Asking the allocator to shrink the buffer instead moves it under jemalloc, the
        // template's allocator, whenever the page is in a smaller size class than its buffer,
        // which is a copy with more work around it (`docs/design.md#choice-kept-pages`).
        let body = Bytes::copy_from_slice(&body);
        let key = Key::new(self.at.as_str(), self.host.as_ref(), sent);
        let Missed { hash, data, asked: made, written, mut told, .. } = self;
        let entry = answers.keep(|place| Entry {
            key,
            hash,
            place,
            written,
            by_language: language,
            data,
            made,
            lifetime,
            head: head_of(&parts.headers),
            // At most `NAMES`, as checked above.
            names: parts.headers.keys_len() as u16,
            cache,
            style,
            body: body.clone(),
            hashed: OnceLock::new(),
            #[cfg(feature = "compress")]
            coded: Default::default(),
            used: AtomicBool::new(false),
            size: AtomicUsize::new(size),
        });
        told.1 = true;
        // This answer's tag and compression are the kept one's first.
        parts.extensions.insert(Kept(entry));
        Response::from_parts(parts, Body::from(body))
    }
}

/// Whether an answer with these headers varies on `Accept-Language`; `None` when it varies on
/// something a kept answer's key does not cover (`*`, a header of the app's), so it is not kept.
/// `corten` and `accept` choose the form of a page's answer, which the request was already
/// asked by: a page is kept for the whole document alone, and a whole body apart for each way
/// of asking.
fn varies(headers: &HeaderMap) -> Option<bool> {
    let mut language = false;
    for line in headers.get_all(header::VARY) {
        for name in line.as_bytes().split(|&b| b == b',').map(<[u8]>::trim_ascii).filter(|name| !name.is_empty()) {
            if name.eq_ignore_ascii_case(b"accept-language") {
                language = true;
            } else if !name.eq_ignore_ascii_case(b"corten") && !name.eq_ignore_ascii_case(b"accept") {
                return None;
            }
        }
    }
    Some(language)
}

/// The bytes a kept answer's head is counted as: each line's name and value, and what holds it.
/// One function for both copies of [`Missed::keep`], so the name of a line is read in one place
/// in the program, as it was: a second place to read it made the compiler stop inlining that
/// read, and a release build counted 36 instructions more a refused request
/// (`tests/router_cost.rs`).
#[inline]
fn head_bytes(headers: http::header::Iter<'_, HeaderValue>) -> usize {
    headers.map(|(name, value)| name.as_str().len() + value.len() + HEADER).sum()
}

/// Under `corten dev`, in the request's signal: its answer is one a release build would keep from
/// here, for its lifetime, as `corten dev`'s copy of [`Missed::keep`] left it, for
/// [`tell_read`] to say so once its body is read.
struct ToRead(u64);

/// Under `corten dev`, in the request's signal: the names and bytes of the head a release build
/// counts for an answer whose locale was negotiated after the page set its headers, which that
/// build names before it counts and `corten dev` leaves for the app to name as the answer leaves.
/// Held in the signal rather than in [`Missed::keep`], so a release build's copy holds nothing
/// more across its read of the body than it did.
struct NamedHead(usize, usize);

/// The head [`NamedHead`] counted, for `corten dev`'s copy of [`Missed::keep`]; none for a
/// release build's.
#[inline(always)]
fn named_head<const TELL: bool>(signal: &crate::Signal) -> Option<(usize, usize)> {
    if !TELL {
        return None;
    }
    signal.found::<NamedHead>().get().map(|&NamedHead(names, bytes)| (names, bytes))
}

/// Under `corten dev`, `res` as `corten dev`'s copy of [`Missed::keep`] left it, with `tell` given
/// what becomes of the body of an answer a release build would keep once it reads it. The body
/// is not read here: a body held whole, which a release build takes without reading, is kept
/// now ([`Verdict::Kept`], not `read`); any other is watched as whatever reads it next (the
/// app's middleware, the client) pulls each frame, and told when it ends ([`Verdict::Kept`],
/// `read`) or fails ([`Verdict::Unread`]), so the answer, its frames, its trailers and when each
/// comes are as they are with no store. That is what `corten dev` saw, not what a release build
/// does: it reads the body before the answer leaves, within the route's deadline and before the
/// request's signal ends (`crate::signal::follow` ends it as an answer of a known size leaves),
/// so a body that is slow, or reads otherwise once the signal has ended, may fare otherwise
/// there. One dropped before its end (the client left) is told nothing. Any other answer is as
/// it was, and `tell` is not called.
pub(crate) fn tell_read<F>(res: Response, signal: &crate::Signal, tell: F) -> Response
where
    F: FnOnce(Verdict) + Send + Unpin + 'static,
{
    let Some(&ToRead(lifetime)) = signal.found::<ToRead>().get() else { return res };
    if res.body().is_whole() {
        tell(Verdict::Kept { lifetime, read: false });
        return res;
    }
    let kept = Verdict::Kept { lifetime, read: true };
    res.map(|body| Body::new(Reading { body, kept, tell: Some(tell) }))
}

/// Under `corten dev`, the body of an answer a release build would keep once it reads it
/// ([`tell_read`]): its frames as they come, and, when it ends, how it ended as `corten dev` read it.
struct Reading<F> {
    body: Body,
    kept: Verdict,
    tell: Option<F>,
}

impl<F: FnOnce(Verdict) + Unpin> http_body::Body for Reading<F> {
    type Data = Bytes;
    type Error = crate::body::BoxError;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        let this = self.get_mut();
        let frame = std::task::ready!(std::pin::Pin::new(&mut this.body).poll_frame(cx));
        // Read to its end, or failed, here: a release build reads it to the end
        // (`crate::body::to_bytes`) before the answer leaves, which may end otherwise.
        let verdict = match &frame {
            None => Some(this.kept),
            Some(Err(_)) => Some(Verdict::Unread),
            Some(Ok(_)) => this.body.is_end_stream().then_some(this.kept),
        };
        if let Some((verdict, tell)) = verdict.and_then(|verdict| Some((verdict, this.tell.take()?))) {
            tell(verdict);
        }
        std::task::Poll::Ready(frame)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A route that left the store out: `UNKEPT_RUN` answers of which none was kept.
    fn left() -> Unkept {
        let route = Unkept::default();
        for made in 0..UNKEPT_RUN {
            assert!(!route.leaves(), "after {made} answers");
            route.made(false);
        }
        route
    }

    /// An `Age` reads as its number, whether it is a slice of the digits or made from the number:
    /// every age the digits hold, and those past them.
    #[test]
    fn an_age_is_its_number_in_decimal() {
        assert_eq!(DIGITS.len(), 38_890);
        for seconds in (0..AGES).chain([AGES, AGES + 1, 86_400, 31_536_000, u64::MAX]) {
            assert_eq!(age_value(seconds).to_str().ok(), Some(seconds.to_string().as_str()), "{seconds}");
        }
        // No allocation under `AGES`: the value's bytes are the digits' own.
        let (digits, held) = (DIGITS.as_bytes().as_ptr_range(), age_value(AGES - 1));
        assert!(digits.contains(&held.as_bytes().as_ptr()));
        assert!(!digits.contains(&age_value(AGES).as_bytes().as_ptr()));
    }

    /// Of a route that left the store out, about one request in 256 asks all the same, and none
    /// waits long for its turn: so a route whose bodies grew is found out.
    #[test]
    fn about_one_request_in_256_of_a_route_that_left_asks() {
        let route = left();
        DRAWN.set(DRAWN_FROM);
        let (mut asked, mut wait, mut longest) = (0, 0, 0);
        for _ in 0..1 << 18 {
            if route.leaves() {
                wait += 1;
                longest = longest.max(wait);
            } else {
                asked += 1;
                wait = 0;
            }
        }
        assert!((922..=1126).contains(&asked), "1,024 of 262,144 within a tenth: {asked}");
        assert!(longest < 4096, "the longest run of requests left: {longest}");
        // An answer kept, or one given from the store, ends it: every request asks again.
        route.made(true);
        assert!((0..1024).all(|_| !route.leaves()));
        let route = left();
        route.found();
        assert!((0..1024).all(|_| !route.leaves()));
    }

    /// An answer kept or given between a request's read of the run and its count is not lost:
    /// the run it ended stays ended, where a plain write of the count read would start it at
    /// its length.
    #[test]
    fn a_run_ended_while_a_request_counted_stays_ended() {
        let route = Unkept::default();
        for _ in 0..UNKEPT_RUN - 1 {
            route.made(false);
        }
        let read = route.0.load(Ordering::Relaxed);
        assert_eq!(read, UNKEPT_RUN - 1);
        route.made(true);
        route.counted(read);
        assert_eq!(route.0.load(Ordering::Relaxed), 0);
        assert!(!route.leaves());
        // With nothing between, the count read is the one counted from.
        route.counted(0);
        assert_eq!(route.0.load(Ordering::Relaxed), 1);
        // A run stops at its length, however many more answers are not kept.
        let route = left();
        for _ in 0..600 {
            route.made(false);
        }
        assert_eq!(route.0.load(Ordering::Relaxed), UNKEPT_RUN);
    }

    /// The request that asks is drawn: of two routes that left the store out and are asked
    /// turn about, each gets to ask, where a count of the thread's requests would come round
    /// to the same one every time.
    #[test]
    fn two_routes_asked_turn_about_both_get_to_ask() {
        let (one, other) = (left(), left());
        DRAWN.set(DRAWN_FROM);
        let (mut first, mut second) = (0, 0);
        for _ in 0..1 << 17 {
            first += u32::from(!one.leaves());
            second += u32::from(!other.leaves());
        }
        assert!((384..=640).contains(&first) && (384..=640).contains(&second), "512 each within a quarter: {first} {second}");
    }

    /// Each thread draws for itself: what one has drawn moves no other's turn.
    #[test]
    fn each_thread_draws_which_request_asks_for_itself() {
        let route = left();
        DRAWN.set(DRAWN_FROM);
        let fresh = Unkept::left_before_one_asks();
        let _ = route.leaves();
        assert_ne!(Unkept::left_before_one_asks(), fresh, "this thread's draws moved on");
        let other = std::thread::spawn(Unkept::left_before_one_asks).join().expect("the thread");
        assert_eq!(other, fresh, "another thread's did not");
    }

    /// Threads that count, end and read a route's run together leave it a run: no more than
    /// its length, and ended by the next answer kept.
    #[test]
    fn a_run_counted_from_many_threads_stays_a_run() {
        let route = Arc::new(Unkept::default());
        let threads: Vec<_> = (0..8)
            .map(|thread| {
                let route = route.clone();
                std::thread::spawn(move || {
                    for turn in 0..20_000_u32 {
                        match (turn + thread) % 7 {
                            0 => route.made(true),
                            1 => route.found(),
                            2 => drop(route.leaves()),
                            _ => route.made(false),
                        }
                        assert!(route.0.load(Ordering::Relaxed) <= UNKEPT_RUN);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("the thread");
        }
        route.made(true);
        assert_eq!(route.0.load(Ordering::Relaxed), 0);
        assert!(!route.leaves());
    }

    /// What [`Sent::read`] reads, by a lookup of each header's name: the rule as the functions
    /// that own each part of it say it.
    fn by_name(headers: &HeaderMap, shape: Shape) -> Option<(Option<&HeaderValue>, Option<&HeaderValue>, bool)> {
        if crate::cache::Credentials::read(headers).personal(|| headers.contains_key(header::AUTHORIZATION)) {
            return None;
        }
        if headers.contains_key(crate::page::MODE_HEADER) {
            return None;
        }
        let data = match (Mode::asked(headers), shape) {
            ((Mode::Document, false), _) => false,
            ((Mode::Data, false), Shape::Body) => true,
            _ => return None,
        };
        let read = [
            crate::page::NOTICE_HEADER,
            header::HeaderName::from_static("last-event-id"),
            header::CONTENT_LENGTH,
            header::TRANSFER_ENCODING,
        ];
        if read.iter().any(|name| headers.contains_key(name)) {
            return None;
        }
        Some((headers.get(header::HOST), headers.get(header::ACCEPT_LANGUAGE), data))
    }

    /// Each line of `headers`, in the order a response is written in.
    fn lines(headers: &HeaderMap) -> Vec<(&header::HeaderName, &HeaderValue)> {
        headers.iter().collect()
    }

    /// An entry and the two counts its `Arc` adds fit jemalloc's class of 448 bytes (the
    /// template's allocator), as they do since its head is a list of lines and not a map: a field
    /// that takes them past it costs every kept answer the next class, 64 bytes more
    /// (docs/design.md#choice-kept-pages). A test and not a check when the crate compiles, which
    /// a release of `http` or `bytes` that an app's lock takes could fail.
    #[test]
    #[cfg(target_pointer_width = "64")]
    fn an_entry_fits_jemallocs_class_of_448_bytes() {
        assert!(std::mem::size_of::<Entry>() + 16 <= 448, "{}", std::mem::size_of::<Entry>());
    }

    #[test]
    fn a_kept_head_is_copied_line_for_line_with_room_for_what_the_stages_add() {
        // Made as a page's head is, with room in its table that a `clone` has as well.
        let mut head = HeaderMap::new();
        head.reserve(13);
        for (name, value) in [
            ("content-type", "text/html; charset=utf-8"),
            ("link", "</a.css>; rel=preload; as=style"),
            ("vary", "corten, accept"),
            ("corten-shell", "f2858fac99b1c5e6"),
            ("vary", "accept-language"),
        ] {
            head.append(header::HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        // A name taken out and put back, so the map's own order is not the order it was filled in
        // (`http` 1.5 moves the last name into the place of one taken out).
        head.remove("link");
        head.append("link", HeaderValue::from_static("</a.css>; rel=preload; as=style"));
        head.append("link", HeaderValue::from_static("</b.js>; rel=modulepreload"));
        // Kept as its lines alone, in the map's order, and made a map of again line for line.
        let kept = head_of(&head);
        assert_eq!(kept.len(), head.len());
        let mut copy = with_room(&kept, head.keys_len());
        assert_eq!(lines(&copy), lines(&head));
        // As many more names as the stages add, and the map is the size it was made, with each
        // line where it was put: the vector a map just large enough holds them in grows on the
        // first of these and moves them, which the size of the map's table does not show.
        let first = |copy: &HeaderMap| std::ptr::from_ref(&copy[header::CONTENT_TYPE]);
        let (room, at) = (copy.capacity(), first(&copy));
        assert!(room >= head.keys_len() + ADDED, "{room}");
        for added in 0..ADDED {
            copy.insert(
                header::HeaderName::from_bytes(format!("x-added-{added}").as_bytes()).unwrap(),
                HeaderValue::from_static("1"),
            );
        }
        assert_eq!(copy.capacity(), room);
        assert_eq!(first(&copy), at);
        assert_eq!(lines(&copy)[..head.len()], lines(&head)[..]);

        // A head of many names, with two lines of one, is given room for all of its names too.
        let mut large = HeaderMap::with_capacity(256);
        for name in 0..=128 {
            large.append(header::HeaderName::from_bytes(format!("x-{name}").as_bytes()).unwrap(), HeaderValue::from(name));
        }
        large.append("x-0", HeaderValue::from_static("again"));
        let copy = with_room(&head_of(&large), large.keys_len());
        assert_eq!(lines(&copy), lines(&large));
        assert_eq!(copy.capacity(), HeaderMap::<HeaderValue>::with_capacity(129 + ADDED).capacity());
    }

    #[test]
    fn the_most_names_kept_and_the_stages_fit_a_map_grown_as_far_as_crowding_grows_one() {
        // `http` grows a crowded map while it has at most five places a name, so to at most ten:
        // a kept head of the most names with the stages' never asks for a map past the most it
        // holds (making a map larger than that panics).
        assert!(HeaderMap::<HeaderValue>::with_capacity(10 * (NAMES + ADDED)).capacity() >= 10 * (NAMES + ADDED));
        assert!(u16::try_from(NAMES).is_ok());
    }

    #[test]
    fn a_kept_head_of_few_names_and_many_values_is_given_room_for_its_names() {
        // Four names and 64 lines, as a page with many `Link`s has: a name's second and later
        // values are held beside the map's table, so they need no room in it.
        let mut head = HeaderMap::new();
        for (name, value) in
            [("content-type", "text/html; charset=utf-8"), ("vary", "corten, accept"), ("corten-shell", "f2858fac99b1c5e6")]
        {
            head.append(header::HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        for at in 0..61 {
            head.append(header::LINK, HeaderValue::from(at));
        }
        assert_eq!((head.keys_len(), head.len()), (4, 64));
        let copy = with_room(&head_of(&head), head.keys_len());
        assert_eq!(lines(&copy), lines(&head));
        assert_eq!(copy.capacity(), HeaderMap::<HeaderValue>::with_capacity(4 + ADDED).capacity());
    }

    #[test]
    fn the_headers_read_in_one_pass_are_what_a_lookup_of_each_name_reads() {
        // Each header not sent, sent, and sent on two lines, with each value that changes what is
        // read of it.
        let sent: [(header::HeaderName, &[&[&[u8]]]); 11] = [
            (
                header::COOKIE,
                &[
                    &[],
                    &[b"corten-zone=UTC"],
                    &[b"sid=1"],
                    &[b"corten-zone=UTC", b"corten-zone=UTC"],
                    &[b"corten-zone=UTC; sid=1"],
                ],
            ),
            (header::AUTHORIZATION, &[&[], &[b"Bearer x"]]),
            (crate::page::MODE_HEADER, &[&[], &[b"nav"], &[b"another"]]),
            (
                header::ACCEPT,
                &[
                    &[],
                    &[b"application/json"],
                    &[b"text/html,application/json"],
                    &[b"text/html", b"application/json"],
                    &[b"application/json", b"text/html"],
                    &[b" application/json ; q=1, text/html"],
                    &[b"\xff"],
                ],
            ),
            (crate::page::NOTICE_HEADER, &[&[], &[b"saved"]]),
            (header::HeaderName::from_static("last-event-id"), &[&[], &[b"7"]]),
            (header::CONTENT_LENGTH, &[&[], &[b"0"]]),
            (header::TRANSFER_ENCODING, &[&[], &[b"chunked"]]),
            (header::HOST, &[&[], &[b"a.example"], &[b"a.example", b"b.example"]]),
            (header::ACCEPT_LANGUAGE, &[&[], &[b"fr"], &[b"fr", b"en"]]),
            // One the rule does not read, as most of a browser's are.
            (header::USER_AGENT, &[&[], &[b"a browser"]]),
        ];
        let (mut kept, mut left, mut apart) = (0, 0, 0);
        let mut choice = [0; 11];
        loop {
            for backwards in [false, true] {
                let mut headers = HeaderMap::new();
                let mut order: Vec<usize> = (0..sent.len()).collect();
                if backwards {
                    order.reverse();
                }
                for at in order {
                    for line in sent[at].1[choice[at]] {
                        headers.append(sent[at].0.clone(), HeaderValue::from_bytes(line).unwrap());
                    }
                }
                let page = Sent::read::<false>(&headers, Shape::Page).map(|sent| (sent.host, sent.language, sent.data));
                assert_eq!(page, by_name(&headers, Shape::Page), "{headers:?}");
                match page {
                    Some(_) => kept += 1,
                    None => left += 1,
                }
                // A whole body is kept for a data client too, apart, and for no one a page is not.
                let body = Sent::read::<false>(&headers, Shape::Body).map(|sent| (sent.host, sent.language, sent.data));
                assert_eq!(body, by_name(&headers, Shape::Body), "{headers:?}");
                assert!(page.is_none() || body == page, "{headers:?}");
                apart += usize::from(matches!(body, Some((_, _, true))));
            }
            // The next choice of lines, as a number with a digit for each header.
            let Some(at) = (0..sent.len()).find(|&at| choice[at] + 1 < sent[at].1.len()) else { break };
            choice[at] += 1;
            choice[..at].fill(0);
        }
        // Both answers were met, for more than the request with no header at all.
        assert!(kept > 100 && left > 100 && apart > 100, "{kept} {left} {apart}");
    }

    /// An answer for `at` whose request found the path's writes as they are now: one that may
    /// be kept, so the counts are made, as [`Missed::keep`] makes them.
    fn entry(answers: &Answers, at: &str, host: Option<&'static str>, lifetime: u64, body: usize) -> impl FnOnce(Place) -> Entry {
        answers.counts();
        let (hash, written) = (answers.0.keys.hash_one(at), Written::of(&answers.0, at));
        let key = Key::new(at, host.map(HeaderValue::from_static).as_ref(), None);
        move |place| Entry {
            key,
            hash,
            place,
            written,
            by_language: false,
            data: false,
            made: Instant::now(),
            lifetime,
            head: Head::default(),
            names: 0,
            cache: crate::cache::Typed::for_test(),
            style: None,
            body: Bytes::from(vec![b'x'; body]),
            hashed: OnceLock::new(),
            #[cfg(feature = "compress")]
            coded: Default::default(),
            used: AtomicBool::new(false),
            size: AtomicUsize::new(body + OVERHEAD),
        }
    }

    /// A store with room is not full and has no marks. Full, it knows a URL asked for before,
    /// each host's apart, and clears its marks once an eighth of them are set.
    #[test]
    fn a_full_store_knows_the_urls_asked_for_before() {
        const BOUND: usize = 64 << 10;
        assert_eq!([1, 2048, BOUND, 3 << 20, 32 << 20].map(marks_for), [1, 1, 32, 2048, 16384]);
        let answers = Answers::new(BOUND).expect("a bound");
        let store = &*answers.0;
        let mut pages = 0;
        while !store.full() {
            answers.keep(entry(&answers, &format!("/kept/{pages}"), None, 60, 1000));
            pages += 1;
            assert!(pages < 100, "the store never filled");
        }
        let held = answers.bytes();
        assert!(held > BOUND - BOUND / SHARE && held <= BOUND, "{pages} pages hold {held} bytes");
        assert!(store.marks.get().is_none(), "no marks until a full store is asked");
        assert!(!store.asked(None, "/items") && store.asked(None, "/items") && store.asked(None, "/items"));
        assert!(!store.asked(None, "/items?page=2"), "another query is another URL");
        let host = HeaderValue::from_static("a.example");
        assert!(!store.asked(Some(&host), "/items") && store.asked(Some(&host), "/items"), "and so is another host's");
        assert_eq!(store.marks.get().map(|marks| marks.len() * 64), Some(2048));
        // 2,048 marks: a URL is known while no more than 256 are set, whatever was asked for since.
        let mut urls = (0..400).map(|n| format!("/catalog/{n}"));
        while store.marked.load(Ordering::Relaxed) < 256 {
            store.asked(None, &urls.next().expect("the marks were cleared early"));
        }
        assert!(store.asked(None, "/items") && store.asked(None, "/catalog/0"), "known with 256 marks set");
        // The next new URL clears them all, its own with them.
        let clearing = urls.find(|url| !store.asked(None, url)).expect("a new URL");
        assert_eq!(store.marked.load(Ordering::Relaxed), 0);
        assert!(!store.asked(None, &clearing) && store.asked(None, &clearing), "the one that cleared them is new again");
        assert!(!store.asked(None, "/items"), "and so is one asked for before");
        assert_eq!(store.marked.load(Ordering::Relaxed), 2);
    }

    /// The bound holds after every answer kept: the one not read since the hand last passed goes
    /// first, one past its lifetime before one that was read, and the bytes counted are those
    /// still kept.
    #[test]
    fn the_bound_holds_and_an_answer_not_read_goes_first() {
        let size = 1000 + OVERHEAD;
        let answers = Answers::new(size * 3).expect("a bound");
        for at in ["/a", "/b", "/c"] {
            answers.keep(entry(&answers, at, None, 60, 1000));
        }
        assert_eq!(answers.bytes(), size * 3);
        // `/a` and `/c` are read; `/b` is not.
        assert!(answers.find("/a", None, None, false).is_some() && answers.find("/c", None, None, false).is_some());
        answers.keep(entry(&answers, "/d", None, 60, 1000));
        assert_eq!(answers.bytes(), size * 3, "one went for the new one");
        assert!(answers.find("/b", None, None, false).is_none(), "the one not read");
        for at in ["/a", "/c", "/d"] {
            assert!(answers.find(at, None, None, false).is_some(), "{at}");
        }
        // One past its lifetime is never given, and goes when the hand comes to it: before one
        // that was read since.
        let answers = Answers::new(size * 2).expect("a bound");
        answers.keep(entry(&answers, "/old", None, 0, 1000));
        answers.keep(entry(&answers, "/b", None, 60, 1000));
        assert!(answers.find("/old", None, None, false).is_none(), "past its lifetime: never given");
        assert!(answers.find("/b", None, None, false).is_some());
        answers.keep(entry(&answers, "/c", None, 60, 1000));
        assert!(answers.find("/b", None, None, false).is_some() && answers.find("/c", None, None, false).is_some());
        assert_eq!(answers.bytes(), size * 2);
    }

    /// A request that may change what `at` shows, as the app's layer meets it.
    fn write<'a>(answers: &'a Answers, at: &str) -> Writing<'a> {
        let req = http::Request::builder().method("POST").uri(at).header("host", "h7.example").body(Body::empty());
        answers.writing(&req.expect("a request"), &crate::Signal::default())
    }

    /// A URL's answer is one copy for each `Host` it was asked with, a new one in the place of the
    /// one it stands for. A write drops every page at its path, and one that did not fail at the
    /// path it redirects to, whatever their queries, and one whose handler read before it.
    #[test]
    fn a_url_has_a_copy_for_each_host_and_a_write_drops_its_path_s() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let (a, b) = (HeaderValue::from_static("a.example"), HeaderValue::from_static("b.example"));
        answers.keep(entry(&answers, "/p", Some("a.example"), 60, 10));
        assert!(answers.find("/p", Some(&a), None, false).is_some());
        assert!(answers.find("/p", Some(&b), None, false).is_none() && answers.find("/p", None, None, false).is_none());
        answers.keep(entry(&answers, "/p", Some("b.example"), 60, 10));
        answers.keep(entry(&answers, "/p", Some("a.example"), 60, 20));
        assert_eq!(answers.bytes(), 30 + OVERHEAD * 2, "the second for a.example took the first's place");
        assert_eq!(answers.find("/p", Some(&a), None, false).expect("kept").0.body.len(), 20);
        // More hosts than a URL keeps copies for: the oldest not read since it was kept goes, so
        // the one read stays.
        for n in 0..COPIES {
            let host: &'static str = Box::leak(format!("h{n}.example").into_boxed_str());
            answers.keep(entry(&answers, "/p", Some(host), 60, 10));
        }
        assert!(answers.find("/p", Some(&b), None, false).is_none() && answers.find("/p", Some(&a), None, false).is_some());
        assert!(answers.find("/p", Some(&HeaderValue::from_static("h0.example")), None, false).is_none());
        assert_eq!(answers.bytes(), 20 + 10 * (COPIES - 1) + OVERHEAD * COPIES);
        let last = HeaderValue::from_static("h7.example");
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::SEE_OTHER;
        res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/q?x=1#top"));
        res.headers_mut().insert(header::CONTENT_LOCATION, HeaderValue::from_static("https://H7.example/made/1"));
        answers.keep(entry(&answers, "/q?x=2", None, 60, 10));
        answers.keep(entry(&answers, "/made/1", None, 60, 10));
        answers.keep(entry(&answers, "/other", None, 60, 10));
        // A page whose handler is reading while the write is made.
        let read_before = entry(&answers, "/q", None, 60, 10);
        // A named post: `?do=save` at its page's path.
        write(&answers, "/p?do=save").answered(&res);
        assert!(answers.find("/p", Some(&last), None, false).is_none(), "the path written, whatever the query");
        assert!(answers.find("/q?x=2", None, None, false).is_none(), "and the path it redirects to");
        assert!(answers.find("/made/1", None, None, false).is_none(), "and the one it says it made, named with this host");
        answers.keep(read_before);
        assert!(answers.find("/q", None, None, false).is_none(), "what was read before the write does not stand");
        assert!(answers.find("/other", None, None, false).is_some());
        answers.keep(entry(&answers, "/p", Some("h7.example"), 60, 10));
        assert!(answers.find("/p", Some(&last), None, false).is_some(), "made after the write, it stands");
        assert!(Answers::new(0).is_none(), "no bound, none kept");
    }

    /// A write counts for its path however it ends and whatever it is answered: the handler may
    /// have written before the client left, before it failed or before it refused. The path is
    /// the same page's however it is escaped.
    #[test]
    fn a_write_that_is_dropped_or_fails_late_drops_its_path_s_however_it_is_escaped() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let kept = |at| answers.find(at, None, None, false).is_some();
        answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
        answers.keep(entry(&answers, "/other", None, 60, 10));
        drop(write(&answers, "/notes/a~b"));
        assert!(!kept("/notes/a%7Eb"), "dropped before its answer, under another escaping");
        answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
        res.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/other"));
        write(&answers, "/notes/a%7eb").answered(&res);
        assert!(!kept("/notes/a%7Eb"), "a handler that failed, or passed its deadline, may have written");
        assert!(kept("/other"), "and what a failure names is not a place it wrote");
        // A handler that refused the request, waited too long for its body or says it does not
        // do this may have saved first, and so may a middleware around a route with no handler
        // for the method: a status does not say.
        let refusals =
            [StatusCode::CONFLICT, StatusCode::REQUEST_TIMEOUT, StatusCode::METHOD_NOT_ALLOWED, StatusCode::NOT_IMPLEMENTED];
        for status in refusals {
            answers.keep(entry(&answers, "/notes/a%7Eb", None, 60, 10));
            assert!(kept("/notes/a%7Eb"));
            *res.status_mut() = status;
            write(&answers, "/notes/a~b").answered(&res);
            assert!(!kept("/notes/a%7Eb"), "{status}");
            assert!(kept("/other"), "{status}: and the place it names is not one it wrote");
        }
        // An escaped `/` is part of its segment, in either case of its digits.
        assert_eq!(count_of(b"/files/a%2Fb"), count_of(b"/files/a%2fb"));
        assert_ne!(count_of(b"/files/a%2Fb"), count_of(b"/files/a/b"));
    }

    /// The counts of writes by path are made with the first answer that may be kept, not with
    /// the first asked for. A write before then reads nothing of its path and is counted with
    /// the others like it, however it ends: a request that asked before one ended has no answer
    /// that stands, and one that began before the counts and ends after answers were kept drops
    /// them all. From then on a write drops its own path's.
    #[test]
    fn the_counts_of_writes_are_made_with_the_first_answer_that_may_be_kept() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let res = Response::new(Body::empty());
        let kept = |at| answers.find(at, None, None, false).is_some();
        // A request that asks, as often as it likes, makes no counts.
        let asked = Written::of(&answers.0, "/q");
        assert!(asked.stands(&answers.0) && answers.0.written.get().is_none());
        let signal = crate::Signal::default();
        let req = http::Request::builder().method("POST").uri("/p").body(Body::empty()).expect("a request");
        let early = answers.writing(&req, &signal);
        assert!(early.counted.is_none() && signal.counts_a_write(), "nothing of its path is read, and it is a write");
        assert!(asked.stands(&answers.0), "a write under way has written nothing a status could tell of");
        early.answered(&res);
        assert!(!asked.stands(&answers.0), "answered at another path: no counts say which");
        let asked = Written::of(&answers.0, "/q");
        drop(write(&answers, "/p"));
        assert!(!asked.stands(&answers.0), "dropped before its answer");
        assert!(Written::of(&answers.0, "/q").stands(&answers.0), "a request that asks after it reads what it wrote");
        assert_eq!(answers.0.early.load(Ordering::Acquire), 2);
        assert!(answers.0.written.get().is_none(), "an app that keeps nothing holds no counts");

        // One that began before the counts were made and is answered after.
        let early = write(&answers, "/p");
        answers.keep(entry(&answers, "/p", None, 60, 10));
        answers.keep(entry(&answers, "/other", None, 60, 10));
        assert!(answers.0.written.get().is_some_and(|counts| counts.len() == WRITES));
        assert!(kept("/p") && kept("/other"));
        let later = write(&answers, "/p");
        assert!(later.counted.is_some(), "a write that finds the counts is counted by its path");
        early.answered(&res);
        assert!(!kept("/p") && !kept("/other"), "it read no path, so no answer stands across it");
        answers.keep(entry(&answers, "/p", None, 60, 10));
        answers.keep(entry(&answers, "/other", None, 60, 10));
        later.answered(&res);
        assert!(!kept("/p") && kept("/other"), "by path from here on");
        assert_eq!(answers.0.early.load(Ordering::Acquire), 3);
    }

    /// A write that ends after a request asked is seen by that request, whichever way the write
    /// was counted and whenever the counts by path came to be: at its own path always, and at
    /// every other when it found no counts. One thread writes freely and makes the counts part
    /// of the way through, no sooner than a turn the round names; another writes in turn with
    /// one that asks, which asks before each of its writes begins and looks once it has ended.
    /// So every one of those writes is checked at its path, and those of the turns before the
    /// counts at another, whatever the scheduler does; the turn the counts are made in is the
    /// one that races them.
    #[test]
    fn a_write_that_ends_as_the_counts_are_made_is_seen_by_who_asked_before() {
        /// Lets the other side of the turns go on if this one ends early, as a failed check does.
        struct Open<'a>(&'a AtomicUsize);
        impl Drop for Open<'_> {
            fn drop(&mut self) {
                self.0.store(usize::MAX, Ordering::SeqCst);
            }
        }
        const WRITES_EACH: usize = 40;
        let (mut early, mut by_path) = (0, 0);
        for round in 0..200_usize {
            // The turn the counts wait for: the writes of the turns before it find none.
            let turn = 2 + round % 4;
            let answers = Answers::new(1 << 20).expect("a bound");
            // The turn the asker opened, the turn the writer ended, and how that write counted.
            let (asked, ended, found_none) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
            let (answers, asked, ended, found_none) = (&answers, &asked, &ended, &found_none);
            // Asked before any write: the free writer's first finds no counts and ends after it.
            let first = Written::of(&answers.0, "/q");
            let (modes, elsewhere) = std::thread::scope(|scope| {
                let free = scope.spawn(move || {
                    let mut modes = (0, 0);
                    for n in 0..WRITES_EACH {
                        if n == 1 + round % (WRITES_EACH - 2) {
                            while asked.load(Ordering::SeqCst) < turn {
                                std::thread::yield_now();
                            }
                            answers.counts();
                        }
                        let write = write(answers, "/p");
                        match write.counted {
                            None => modes.0 += 1,
                            Some(_) => modes.1 += 1,
                        }
                        write.answered(&Response::new(Body::empty()));
                        std::thread::yield_now();
                    }
                    modes
                });
                let turned = scope.spawn(move || {
                    let _open = Open(ended);
                    let mut modes = (0, 0);
                    for n in 1..=WRITES_EACH {
                        while asked.load(Ordering::SeqCst) < n {
                            std::thread::yield_now();
                        }
                        let write = write(answers, "/p");
                        match write.counted {
                            None => modes.0 += 1,
                            Some(_) => modes.1 += 1,
                        }
                        found_none.store(usize::from(write.counted.is_none()), Ordering::SeqCst);
                        write.answered(&Response::new(Body::empty()));
                        ended.store(n, Ordering::SeqCst);
                    }
                    modes
                });
                let asker = scope.spawn(move || {
                    let _open = Open(asked);
                    let mut elsewhere = 0;
                    for n in 1..=WRITES_EACH {
                        let (here, there) = (Written::of(&answers.0, "/p"), Written::of(&answers.0, "/q"));
                        asked.store(n, Ordering::SeqCst);
                        while ended.load(Ordering::SeqCst) < n {
                            std::thread::yield_now();
                        }
                        // Its write began after this asked, and has ended.
                        assert!(!here.stands(&answers.0), "a write ended at the path since the request asked");
                        if found_none.load(Ordering::SeqCst) == 1 {
                            assert!(!there.stands(&answers.0), "a write that found no counts ended since");
                            elsewhere += 1;
                        }
                    }
                    elsewhere
                });
                let (free, turned, asker) = (free.join(), turned.join(), asker.join());
                let (free, turned) = (free.expect("the free writer"), turned.expect("the writer in turn"));
                ((free.0 + turned.0, free.1 + turned.1), asker.expect("the one that asks"))
            });
            assert!(!first.stands(&answers.0), "a write that found no counts ended since the round's first request");
            assert!(elsewhere >= turn - 1, "the writes of the turns before the counts found none: {elsewhere}");
            early += modes.0;
            by_path += modes.1;
        }
        // Both ways of counting were met.
        assert!(early > 0 && by_path > 0, "{early} {by_path}");
    }

    /// Threads that keep, read, grow and write at once leave the bytes counted equal to what the
    /// entries count for, each entry in one slot and one URL's copies, within the bound.
    #[test]
    fn the_bytes_counted_are_the_entries_whatever_threads_did_at_once() {
        const BOUND: usize = 64 << 10;
        let answers = Answers::new(BOUND).expect("a bound");
        std::thread::scope(|scope| {
            for thread in 0..4_usize {
                let answers = &answers;
                scope.spawn(move || {
                    for n in 0..4000_usize {
                        let at = format!("/p{}", (n * 7 + thread * 13) % 97);
                        match n % 4 {
                            0 | 1 => drop(answers.keep(entry(answers, &at, None, 60, 500 + n % 300))),
                            2 => {
                                if let Some((found, _)) = answers.find(&at, None, None, false) {
                                    #[cfg(feature = "compress")]
                                    found.grew(100);
                                    drop(found);
                                }
                            }
                            _ => answers.count(count_of(at.as_bytes())),
                        }
                    }
                });
            }
        });
        let inner = answers.0.inner.read().unwrap_or_else(PoisonError::into_inner);
        let sizes: Vec<usize> = inner.slots.iter().flatten().map(|entry| entry.size.load(Ordering::Acquire)).collect();
        assert!(!sizes.is_empty() && sizes.iter().all(|&size| size != GONE));
        assert_eq!(answers.bytes(), sizes.iter().sum::<usize>());
        assert_eq!(inner.at.values().map(Vec::len).sum::<usize>(), sizes.len());
        assert!(answers.bytes() <= BOUND, "{}", answers.bytes());
    }

    #[test]
    fn a_write_s_answer_names_a_place_on_this_site_by_its_path_or_with_its_host() {
        let host = HeaderValue::from_static("shop.example:8443");
        let on = |to: &'static str| on_site(to.as_bytes(), Some(&host)).map(|path| std::str::from_utf8(path).expect("a path"));
        assert_eq!(on("/q?x=1#top"), Some("/q"));
        assert_eq!(on("/"), Some("/"));
        assert_eq!(on("https://shop.example:8443/q/r?x"), Some("/q/r"));
        assert_eq!(on("HTTP://SHOP.example:8443"), Some("/"));
        assert_eq!(on("//shop.example:8443/q#top"), Some("/q"));
        assert_eq!(on("https://shop.example:8443?x=1"), Some("/"));
        for elsewhere in ["https://other.example/q", "//other.example/q", "https://shop.example/q", "q", "../q", "", "mailto:a@b"]
        {
            assert_eq!(on(elsewhere), None, "{elsewhere}");
        }
        assert_eq!(on_site(b"https://shop.example:8443/q", None), None, "no host to hold it to");
        assert_eq!(on_site("/caf\u{e9}".as_bytes(), None), Some("/caf\u{e9}".as_bytes()), "a path that is not ASCII");
    }

    /// A whole body asked for as data is a copy of its own, replaced by one asked the same way:
    /// its handler may have read which client asked.
    #[test]
    fn a_body_asked_for_as_data_is_a_copy_of_its_own() {
        let answers = Answers::new(1 << 20).expect("a bound");
        answers.keep(entry(&answers, "/v", None, 60, 10));
        assert!(answers.find("/v", None, None, false).is_some() && answers.find("/v", None, None, true).is_none());
        let data = entry(&answers, "/v", None, 60, 20);
        answers.keep(move |place| Entry { data: true, ..data(place) });
        assert_eq!(answers.find("/v", None, None, true).expect("kept").0.body.len(), 20);
        assert_eq!(answers.find("/v", None, None, false).expect("still kept").0.body.len(), 10);
        let again = entry(&answers, "/v", None, 60, 30);
        answers.keep(move |place| Entry { data: true, ..again(place) });
        assert_eq!(answers.find("/v", None, None, true).expect("kept").0.body.len(), 30);
        assert_eq!(answers.bytes(), 10 + 30 + 2 * OVERHEAD, "the one asked the same way went");
    }

    /// A copy that no longer stands is in no other's way, and goes when its URL is kept again.
    #[test]
    fn a_copy_that_no_longer_stands_is_not_in_another_s_way() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let (fr, en) = (HeaderValue::from_static("fr"), HeaderValue::from_static("en"));
        // For every language, and past its lifetime.
        answers.keep(entry(&answers, "/p", None, 0, 10));
        let (french, asked) = (entry(&answers, "/p", None, 60, 20), Key::new("/p", None, Some(&fr)));
        answers.keep(move |place| Entry { key: asked, by_language: true, ..french(place) });
        assert_eq!(answers.find("/p", None, Some(&fr), false).expect("the one that stands").0.body.len(), 20);
        assert!(answers.find("/p", None, Some(&en), false).is_none());
        assert_eq!(answers.bytes(), 20 + OVERHEAD, "the one past its lifetime went when the URL was kept again");
    }

    /// Two URLs with the same hash share a place in the table and are told apart by the URL each
    /// copy holds: neither is found for the other, takes the other's place or goes with it, and
    /// the copies one URL keeps are counted, and give way, among its own.
    #[test]
    fn urls_that_share_a_hash_are_told_apart() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let keep = |at: &str, body| {
            let make = entry(&answers, at, None, 60, body);
            answers.keep(move |place| Entry { hash: 7, ..make(place) })
        };
        let a = keep("/a", 10);
        keep("/b", 20);
        assert_eq!(answers.found(7, "/a", None, None, false).expect("kept").0.body.len(), 10);
        assert_eq!(answers.found(7, "/b", None, None, false).expect("kept").0.body.len(), 20);
        assert!(answers.found(7, "/c", None, None, false).is_none());
        keep("/b", 30);
        assert_eq!(answers.bytes(), 40 + OVERHEAD * 2, "the second /b took the first /b's place alone");
        answers.0.drop_entry(&mut answers.0.inner.write().unwrap_or_else(PoisonError::into_inner), &a);
        assert!(answers.found(7, "/a", None, None, false).is_none());
        assert_eq!(answers.found(7, "/b", None, None, false).expect("still kept").0.body.len(), 30);
        assert_eq!(answers.bytes(), 30 + OVERHEAD);

        // `/b`, never read, then a copy of `/a` for as many hosts as a URL keeps: none is in
        // `/b`'s way. One more `/a` takes an `/a`'s place, not the unread `/b`'s.
        let answers = Answers::new(1 << 20).expect("a bound");
        let keep = |at: &str, host, body| {
            let make = entry(&answers, at, host, 60, body);
            answers.keep(move |place| Entry { hash: 7, ..make(place) })
        };
        let hosts: Vec<&'static str> = (0..=COPIES).map(|n| &*Box::leak(format!("h{n}.example").into_boxed_str())).collect();
        keep("/b", None, 20);
        for &host in &hosts[..COPIES] {
            keep("/a", Some(host), 10);
        }
        assert_eq!(answers.bytes(), 20 + 10 * COPIES + OVERHEAD * (COPIES + 1), "no copy went");
        keep("/a", Some(hosts[COPIES]), 10);
        assert_eq!(answers.bytes(), 20 + 10 * COPIES + OVERHEAD * (COPIES + 1), "one went for the new one");
        assert_eq!(answers.found(7, "/b", None, None, false).expect("still kept").0.body.len(), 20);
        let found = |host| answers.found(7, "/a", Some(&HeaderValue::from_static(host)), None, false);
        assert!(found(hosts[0]).is_none(), "the oldest /a not read");
        for &host in &hosts[1..] {
            assert!(found(host).is_some(), "{host}");
        }
    }

    /// A key reads back the URL, `Host` and `Accept-Language` it was made of, each apart, in one
    /// allocation of their length.
    #[test]
    fn a_key_reads_back_what_it_was_made_of() {
        let (host, language) = (HeaderValue::from_static("a.example"), HeaderValue::from_static("fr"));
        for (sent_host, sent_language) in
            [(None, None), (Some(&host), None), (None, Some(&language)), (Some(&host), Some(&language))]
        {
            let key = Key::new("/p?q=1", sent_host, sent_language);
            assert_eq!(key.at(), b"/p?q=1");
            assert_eq!(key.host(), sent_host.map(HeaderValue::as_bytes));
            assert_eq!(key.language(), sent_language.map(HeaderValue::as_bytes));
            assert_eq!(key.bytes.len(), 6 + sent_host.map_or(0, HeaderValue::len) + sent_language.map_or(0, HeaderValue::len));
        }
    }

    #[test]
    fn an_answer_is_kept_only_when_its_vary_is_covered() {
        let vary = |lines: &[&'static str]| {
            let mut headers = HeaderMap::new();
            for line in lines {
                headers.append(header::VARY, HeaderValue::from_static(line));
            }
            varies(&headers)
        };
        assert_eq!(vary(&[]), Some(false));
        assert_eq!(vary(&["corten, accept"]), Some(false));
        assert_eq!(vary(&["Corten, Accept, Accept-Language"]), Some(true));
        assert_eq!(vary(&["corten", "accept-language"]), Some(true));
        for other in [&["*"][..], &["corten, accept, corten-notice"], &["corten", "x-tenant"], &["cookie"]] {
            assert_eq!(vary(other), None, "{other:?}");
        }
    }

    /// The tag's hash of a kept body and its bytes in a coding are made once and counted, while
    /// the response still carries the kept bytes: a body put in their place is hashed and coded
    /// for itself, and nothing is counted for an answer that is no longer kept.
    #[test]
    fn a_kept_answer_s_hash_and_coded_bytes_are_made_once() {
        let answers = Answers::new(1 << 20).expect("a bound");
        let kept = answers.keep(entry(&answers, "/p", None, 60, 2000));
        let mut extensions = http::Extensions::new();
        extensions.insert(Kept(kept.clone()));
        let key = std::hash::RandomState::new();
        let hash = |body: &Bytes| Kept::hashed(&extensions, body, &key).finish();
        let copy = Bytes::copy_from_slice(&kept.body);
        assert!(kept.hashed.get().is_none());
        assert_eq!(hash(&copy), hash(&kept.body), "the same bytes, the same hash, kept or not");
        assert!(kept.hashed.get().is_some(), "kept for the next tag");
        assert_eq!(hash(&kept.body), hash(&copy));
        let other = Bytes::from_static(b"another body");
        assert_ne!(hash(&other), hash(&kept.body), "a body a middleware put in its place");

        #[cfg(feature = "compress")]
        {
            use crate::compress::Coding;
            let made = std::cell::Cell::new(0);
            let encode = || {
                made.set(made.get() + 1);
                Bytes::from_static(b"coded")
            };
            let before = answers.bytes();
            for _ in 0..3 {
                assert_eq!(Kept::coded(&extensions, &kept.body, Coding::Gzip, encode), "coded");
            }
            assert_eq!((made.get(), answers.bytes()), (1, before + 5), "made once, and counted");
            Kept::coded(&extensions, &other, Coding::Gzip, encode);
            Kept::coded(&http::Extensions::new(), &kept.body, Coding::Gzip, encode);
            assert_eq!((made.get(), answers.bytes()), (3, before + 5), "not the kept answer's");
            // Another answer takes its place.
            answers.keep(entry(&answers, "/p", None, 60, 10));
            assert_eq!(answers.bytes(), 10 + OVERHEAD);
            Kept::coded(&extensions, &kept.body, Coding::Brotli, encode);
            assert_eq!((made.get(), answers.bytes()), (4, 10 + OVERHEAD), "no longer kept: nothing is counted for it");
        }
    }

    /// The bound holds for what is made after a page is kept too: a coded form that takes the
    /// store past it makes room as a new page does, and not by dropping the page it was made for.
    #[cfg(feature = "compress")]
    #[test]
    fn a_coded_form_that_passes_the_bound_makes_room() {
        use crate::compress::Coding;
        let size = 1000 + OVERHEAD;
        let answers = Answers::new(size * 2 + 100).expect("a bound");
        let first = answers.keep(entry(&answers, "/a", None, 60, 1000));
        let second = answers.keep(entry(&answers, "/b", None, 60, 1000));
        assert_eq!(answers.bytes(), size * 2);
        let mut extensions = http::Extensions::new();
        extensions.insert(Kept(second.clone()));
        let coded = Kept::coded(&extensions, &second.body, Coding::Zstd, || Bytes::from(vec![b'z'; 400]));
        assert_eq!(coded.len(), 400);
        assert_eq!(answers.bytes(), size + 400, "the other page went, and the bound holds");
        assert!(answers.find("/a", None, None, false).is_none() && answers.find("/b", None, None, false).is_some());
        assert_eq!(first.size.load(Ordering::Acquire), GONE);
    }
}
