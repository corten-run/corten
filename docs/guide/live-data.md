# Live data

[Back to the guides](../../README.md#documentation)

Corten has two ways to keep a page current, both over server-sent events.

## Fragments: `<corten-live>`

For server-rendered parts that change (a status line, a notification count), stream views:
`corten::live(stream)` turns a stream of rendered HTML into server-sent events, and
`<corten-live src>` swaps each fragment into the page by `id`, like a form's patch. No script of
your own; the stream closes when the element leaves the page. When the stream ends the element
stays as it is instead of reconnecting, so a stream of one fragment is a slow part of a page sent
when it is ready. A server shutting down ends its streams first, and those browsers reconnect.

```rust,ignore
// the route: one fragment, when the slow read is done; it replaces the element with its id
async fn picks(State(shop): State<Shop>) -> LiveResponse {
    corten::live(futures_util::stream::once(async move {
        let picks = shop.picks_for_you().await;
        Picks { picks: &picks }.to_html()
    }))
}

// the page: drawn without them, then completed
html! { <corten-live src={url::Picks}><p id={PicksId}>"Finding picks for you..."</p></corten-live> }
```

A value that keeps changing is the next section's `corten::live_watch`.

### Resuming

A part whose data changes rarely should not be drawn again on every page view and reconnect. Give
each fragment the app's cursor after it, `Fragment::new(html).cursor(seq)` (a version, a
sequence number, a realtime stream's position; Corten only carries it), and the page the cursor
it was rendered at, `<corten-live src={..} since={seq}>`. The handler's `LiveSince` is that
cursor on the first connection, and on a reconnect the last fragment's (the browser sends it
back as `Last-Event-ID`); `None` when there is neither. Send what changed after it, or nothing
until the next change when it is current.

One value that changes, kept in a `tokio::sync::watch` channel (the last trade and the trade
count), is `corten::live_watch(values, since, cursor, view)`: it sends the current value only to a
page that is behind, then the latest after each change (a browser needs no value it missed in
between), and ends when the channel's sender is dropped:

```rust,ignore
async fn trades(State(market): State<Market>, since: LiveSince) -> LiveResponse {
    corten::live_watch(market.trades.subscribe(), since, |(n, _)| *n, |(_, text)| LastTrade { text }.to_html())
}
```

`view` runs once per open page for each change, since what a page is sent may depend on its
request (the reader's language, who is signed in, as auction-room's lot and notices do). A part
that is the same on every page and not small (a table of quotes, a leaderboard) is rendered once,
by the task that changes the value, and sent with it: the cursor, the value in an `Arc` (each
page clones what the channel holds) and its HTML, `watch::Sender<(u64, Arc<Quotes>, Arc<str>)>`,
with `|(_, _, html)| html.to_string()` as the view. The page still renders the part itself, from
the value it reads with the cursor in one `borrow()`, so `since` names the version it shows and
its render notes the part's styles and scripts. Rendered by the task, outside any request, the
part's dates are written in UTC and its translated text (messages) in the one language the task
chooses, so it is the same on every page only when it has no messages and no dates, or its dates
take `.zone(..)` ([Views](views.md), dates). For a 50-row table of 3,132 bytes on 300 open
pages, a change costs 2.3 million instructions where rendering on each page took 7.6 million
(callgrind, three runs each: 2.27 to 2.36 and 7.58 to 7.82; `what_a_change_costs_live_watch` in
`crates/corten/src/tests.rs`); that counts each page's event, not its compression or its write
to the socket. The watchlist's last trade is one line, so it renders on each page.

Another source (a database's change stream, a queue) does the same with `corten::live`: compare
`since` with the version the part is at, send the current part first only when they differ, and
give each fragment its version with `Fragment::cursor`.

A job another process runs (a worker writing to a shared database, a third party's job API) has
no channel to watch, only a read to repeat. When many pages can follow the same job, one task
of the app's ([`App::task`](app.md#tasks)) reads it on an interval into a `watch` channel, and
each page's stream is `live_watch` over it: one read per interval however many pages are open.
A job only one page follows reads in its own stream, with `corten::live` over a loop that reads,
sends the part only when its version moved, ends after the state that settles it, and after a
few failed reads in a row draws that the job could not be read before it ends:

```rust,ignore
async fn batch_live(Path(id): Path<BatchId>, State(jobs): State<Jobs>, since: LiveSince) -> LiveResponse {
    // The version the page shows, failed reads in a row, and the wait before the next read
    // (None once the batch has settled and its last state is sent).
    let start = (since.0, 0, Some(Duration::ZERO));
    corten::live(futures_util::stream::unfold(start, move |(shown, mut failed, wait)| {
        let jobs = jobs.clone();
        async move {
            let mut wait = wait?;
            loop {
                tokio::time::sleep(wait).await;
                wait = Duration::from_secs(1);
                match jobs.batch(id).await {
                    Ok(batch) => {
                        failed = 0;
                        let version = batch.version.to_string();
                        let next = batch.running().then_some(wait);
                        if shown.as_deref() != Some(version.as_str()) {
                            let part = Fragment::new(BatchPanel { batch: &batch }.to_html()).cursor(version.clone());
                            return Some((part, (Some(version), 0, next)));
                        }
                        next?;
                    }
                    Err(error) if failed < 10 => {
                        failed += 1;
                        tracing::warn!(%error, "reading batch {id}");
                    }
                    Err(_) => {
                        // Ending without a word would look settled: the element keeps what it drew.
                        let part = Fragment::new(BatchUnreadable { id }.to_html());
                        return Some((part, (shown, 0, None)));
                    }
                }
            }
        }
    }))
}
```

The version is one the job writes (a counter, an update time); without one, a hash of the
rendered part does (a cursor another deploy does not know only draws the part again). A
settled batch is sent once more if the page has not drawn it, and the stream ends; a stream that
ends sends `end`, and the element keeps the last state it drew. How often to read, what to read
less often (a costly part every few reads), when the job is done and what giving up draws are
the app's to choose, so this loop is written in the app; what many pages share is `live_watch`.
A handler that renders one part for two uses in its answer (the page, and the cursor or
fragment it also keeps) renders it once with `req.rendered(view)` and places a reference to it
(`let placed = &part;`, then `{placed}`), which keeps the sizes and scripts its render noted; text
from `to_html()` placed with `raw` keeps neither. A stream renders its own parts as it is read,
as above.

`App::task` starts its tasks with the app, so jobs that start while it runs share one task: it
reads each running job and sends to that job's `watch` channel (a map from the job to its
sender), and drops the sender once the job settles, which ends every `live_watch` on it.

A cursor the app no longer knows (too old, another deploy's) is the handler's to handle; drawing
the part as it is now is always correct. A cursor with a line break or NUL would end its event,
so `cursor` refuses it (a panic in debug builds; in release the fragment goes without it).

[examples/watchlist](../../examples/watchlist) has this running for everyone.
[examples/auction-room](../../examples/auction-room) also streams each bidder's own notices (you
were outbid, you won): the route takes the `Caller`, so each stream is that caller's own `watch`
channel.

### Connection

Each open stream holds one of the browser's connections to the host. Over HTTP/1.1 a browser opens
about six, so a page with a few live parts open in a few tabs uses them up and its other requests
wait; serve browsers HTTP/2 or HTTP/3 from the proxy or CDN in front of the app, which carries every
stream on one connection (Corten itself speaks HTTP/1.1; [design Limit 14](../design.md#limit-http1)). Streams say `X-Accel-Buffering: no`, so
nginx passes their events on as they are written ([Deploying](deploy.md#live-streams)).

A browser without JavaScript gets no stream: a page whose part is relayed while a job runs asks
it alone to reload, with `ReadAgain { after }.without_javascript()` in its head
([read again](requests-and-forms.md)).

`<corten-live>` shows its connection on itself, so a page can say a part is stale with CSS alone:
`status` is `connecting`, `live` once the stream is open, `reconnecting` while the browser
retries after a drop, `closed` when it gave up (the server answered with no stream: an error, a
204) and `ended` when the server finished the stream (`end`). After a live stream drops,
`stale-since` holds when (an ISO time), until it is live again.

```css
corten-live[status="reconnecting"]::before { content: "Reconnecting"; }
corten-live[status="closed"] .reload { display: inline; }
```

The UI kit's `LiveDot` reads the same attribute: a badge's dot inside the element pulses only while
it is `live` ([kit](kit.md)). Its words follow the attribute the same way, since the pulse is not
the only sign of the state (the dot is not read, and it is still for a user who asks for less
motion). With "Live" in a `.when-live` span and "Not live" in a `.when-not` one, these rules
show "Not live" until the stream is live, so it is true before the runtime runs and without
JavaScript, and, like the dot, say "Live" while any stream around them is:

```css
.when-live { display: none; }
:where(corten-live[status="live"]) .when-live { display: inline; }
:where(corten-live[status="live"]) .when-not { display: none; }
```

Each change of `status` also dispatches a bubbling `corten-status` event on the element, for a
script that writes text CSS cannot ("Stale since 10:42", in the user's time zone). A handler
takes it like any other and reads the attributes, which hold the state:

```rust,ignore
let note = refs();
html! {
    <corten-live src={url::Trades} on:corten-status={js::stale(target, note, t.js().stale_since())}>..</corten-live>
    <output ref={note}></output>
}
```

```js
/** @param {HTMLElement} live @param {HTMLOutputElement} note @param {Message<"time">} since */
export function stale(live, note, since) {
  const at = live.getAttribute("stale-since");
  note.textContent = at ? since({ time: new Date(at).toLocaleTimeString() }) : "";
}
```

An event before the page's scripts have loaded runs nothing, as for any event; read the
attributes in `on:connect` too when the first state matters.

### Redrawing is cheap

With feature `compress`, a live stream is compressed as one stream per connection and flushed
after every event, so each event arrives at once and the compressor remembers the ones before it.
A fragment drawn again with one value changed costs about what changed: on a 6 KB list of 33
rows, the first event is 425 bytes with zstd and each redraw 16 to 23. So drawing a whole region
again is usually cheaper on the wire than it looks, and needs no script. A browser that accepts
zstd (Chromium, Firefox) gets zstd, whose context is kept for events up to about 64 KB apart; any
other that accepts gzip (Playwright's WebKit, which does not send zstd) gets gzip, whose window is
32 KB, so a redraw of a larger region costs more there (each part of an event over 32 KB reaches
back only 32 KB, so most of the one before is out of its reach). A stream is never brotli: WebKit
(Playwright's build on Windows, measured; Safari was not tried) dispatches a flushed brotli event
that decodes to more than 16 KiB only when more of the stream arrives, so the last change before a
quiet spell would show late ([design Choice 32](../design.md#choice-stream-coding)). Each open
stream holds about 0.5 MB (zstd) or 0.35 MB (gzip) while it is open; past 256 MB for all of them,
new streams go out uncompressed.

## Rows: feeds

For scripts that keep state (a table of live prices, a grid), a `corten::feed::Feed<Row>`
(feature `feed`) holds keyed rows and serves a snapshot plus ordered patches; an `on:connect`
handler calls `subscribe(feed, { snapshot, patch, status }, { signal })`.

A row derives `Row` beside `Clone` and `Serialize`, and marks the field that keys it, the id its
upserts and removes name: a `String` or another type that derefs to `str` (`Box<str>`, `&'static
str`). The feed sends what `Serialize` writes, so `#[serde(..)]` on the row, the id included,
changes the JSON and not the key; a script reads the key under the id's serde name, so the derive
refuses a serde attribute that leaves the id out or writes or reads it as other text than `id()`
returns (`skip` and its variants, `with`, `serialize_with`, `deserialize_with`, `flatten`), an id
read under another name than it is written under or under an `alias` too, another field written or read under the id's
key (a `rename`, an `alias`, the row's `rename_all` or `tag`; a flattened field's members are not
checked), and
`into`, `transparent`, `from` or `try_from` on the row. It reads the row's attributes, not the
id type's own `Serialize` and `Deserialize`, so an id type that writes or reads other than the
text it derefs to is not checked, nor is a row whose `Serialize` or `Deserialize` is not serde's
derive. `Row` is the derive and the trait at once (`use corten::feed::Row`); a struct row with
named fields, keyed by one of them, derives it, and only a row the derive cannot express (such as
an enum, a tuple struct, whose fields serde writes without names, a key made of several fields, or
an `id` that does more than return a field) implements it by hand. A generic row needs no bounds on its parameters: it is a row for each type argument that
makes it `Clone`, `Serialize`, `Send`, `Sync` and `'static`. An `Arc<str>` id needs serde's `rc`
feature.

```rust
use corten::feed::Row;

#[derive(Clone, serde::Serialize, Row)]
pub struct Stock {
    #[row(id)]
    pub ticker: String,
    pub price_cents: u32,
}

// By hand, for a row that is an enum.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind")]
pub enum Entry { Note { key: String, text: String }, Tag { key: String } }
impl Row for Entry {
    fn id(&self) -> &str {
        match self {
            Entry::Note { key, .. } | Entry::Tag { key } => key,
        }
    }
}
```

A row with no field marked, two marked, a field marked twice, an id that is not text, an enum,
a tuple struct, a unit struct, a `row` attribute on the struct, a `row` attribute that is not
`#[row(id)]` on a field, or another member serde writes or reads under the id's key does not
compile, and neither does a row that is not `Clone`, `Serialize`, `Send`, `Sync` and `'static`,
the trait's bounds (a generic row, where a feed of it is built; each case is a `compile_fail` example in the documentation of
`corten::feed::Row`).

```rust,ignore
let stocks = Feed::new(rows);
// in the routes module: each feed route names its rows
//   #[route("/feed/stocks", get = stocks, rows = Stock)] pub struct Stocks;
//   #[route("/feed/stocks/live", get = stocks_live, rows = Stock)] pub struct StocksLive;
async fn stocks(State(m): State<Market>) -> FeedResponse<Stock> { m.stocks.snapshot() }
async fn stocks_live(State(m): State<Market>, since: Since) -> FeedResponse<Stock> { m.stocks.live(since) }

// a write: one numbered patch with the final value of every row it touched
market.stocks.write(|tx| if let Some(s) = tx.get_mut("s1") { s.set_price(13_250) });
```

The row type goes from the feed to the script, checked at each step. `Feed<Stock>` answers
`FeedResponse<Stock>`; the route says `rows = Stock`, and a handler that answers with other rows
(or a feed's route that names none) does not compile. The markup passes the route,
`js::watch(.., url::Stocks, signal)`, to a parameter the script declares as `FeedUrl<Stock>`
(from `corten`). `Stock` there is the Rust type of that name in the component's module (bring it
in with `use`; `FeedUrl<import("../types/app").Stock>` reads the same), so the parameter takes
only a route whose rows are that type. A `FeedUrl` Corten cannot read (`FeedUrl<Stock[]>`) is an
error, not an unchecked string. `subscribe()` takes the row type from it, so `snapshot` and
`patch` are typed without a `@param` of their own, and a `Stock` handler given a `Level` feed
fails `tsc`:

```js
/** @import { FeedUrl } from "corten" */
/** @typedef {import("../types/app").Stock} Stock */

/** @param {FeedUrl<Stock>} feed @param {AbortSignal} signal */
export function watch(feed, signal) {
  subscribe(feed, { snapshot: (rows) => rows.forEach(paint), patch: () => {} }, { signal });
}
```

A plain `string` is not a `FeedUrl`, so a script cannot follow a feed whose rows it guessed.
`examples/deck-builder` follows its saved deck this way, so a save made in another tab reaches a
page that is open.

`snapshot` also gets the write's `seq` and the feed's generation, `epoch` (`Feed::generation`).
A script that uses the feed's `seq` as a version (the deck builder sends it with a save, so a save
built on an older deck is refused) compares the pair: `seq` only counts writes within one
generation, and after a restart (a `Feed::new` feed) the new `seq` may be lower, equal or higher
than one the page holds without being the same deck. Render the generation next to the version,
and treat a snapshot from another generation as news whatever its `seq`. `reset` keeps the
generation, so a feed that starts following another log is a new `Feed::follow` with that log's
generation, not a `reset`. A generation is ASCII letters, digits, `.` and `_` (`deploy.3`, a
hex time): it is the cursor's epoch, which goes into the stream's URL and each event's `id:` line
as it is, so `Feed::follow` panics on any other character (`deploy:3`, base64's `/` and `=`, a
`-`) where it is set, instead of serving a feed that never goes live.

Feed guarantees: every `write` is one numbered patch carrying the final value of each row it
touched, encoded once and sent as the same bytes to every subscriber. A snapshot is serialized
once per change too: its body is kept (in memory, the size of the JSON) until the next write,
`apply` or `reset`, so pages that subscribe between two writes cost no serialization. A
subscriber gets the snapshot and then each later patch exactly once, in order; reconnects resume
from `Last-Event-ID`, and an unknown cursor or a gap ends in a fresh snapshot. A stream that
answers the cursor the snapshot just gave with `sync` as it first opens (two feeds behind one
URL, say) refuses it, so `subscribe()` loads the snapshot again after a backoff that doubles from
1 s to 30 s, not straight away; a `sync` later or after a reconnect (a `reset`) loads it at
once. Against a feed that answers every stream with `sync`, one page made 544 snapshot requests
in 3.5 s with the runtime before the backoff and 3 with it in Chromium (Firefox 328 and 3, WebKit
221 and 3; measured with the check in `scripts/smoke.mjs`, which holds the 3). `corten-cluster`
runs one feed across instances (Postgres outbox, a leased relay to NATS JetStream): in the
failover benchmark (200 clients, 50 writes a second, each instance killed and restarted under
load), every patch arrived in both committed runs: 777,600 of 777,600, and 800,000 of 800,000
with clients back on the other instance after 1.1 s at the median (measured,
`examples/listings-feed/results/failover-r1.json` and `failover-r2.json`). Those 200
clients are the benchmark's own Node client of the feed's protocol, on its own retry schedule,
and it counts a gap in `seq` as lost rather than loading a snapshot: they show what the server
sends through a failover. Beside them a Chromium page runs `subscribe()` itself through the
same run, and it lost nothing either (3,888 of 3,888 and 4,000 of 4,000, one snapshot each).
`subscribe()`'s recovery from a gap in `seq`, a stream answered with an HTTP error and a failed
snapshot is checked in Chromium, Firefox and WebKit by `scripts/smoke.mjs`, and from a `sync`
in all three except a `sync` on a stream already open, which WebKit skips. What the cluster does on the
way is logged through the app's subscriber, as the feed's own events are (target `corten::feed`,
fields `instance` and `feed`): a warning for a gap in a feed's patches (`have`, `got`) and the
reload it starts, a patch dropped as invalid, a reload, the JetStream consumer or a resubscribe
that failed, and a feed loaded with no replay log (clients that move to the instance resync), and
`relay active` and `relay standing by` as the relay's lease moves, so a log pipeline counts gaps
and failovers. `Cluster::start` starts the relay before `serve` installs Corten's default
subscriber, so events while the app starts (an instance taking the lease as it starts, or failing
to) print only with a `tracing` subscriber the app installed before `Cluster::start`
(`tracing-subscriber`'s, for one). An instance serves
many feeds, and loading one (on first use, after an idle unload or a gap) or applying a patch to
one does not hold up requests for the others: a feed is built from its rows on a blocking
thread, outside the lock that finds a feed. Reading the rows (the app's `Source::rows`) runs on
a worker thread like any request's work, so on a runtime of one worker a large load still holds
up other requests while its rows are read.

Native apps and agents follow the same feed with `corten-protocol`'s `Replica`; see
[Surfaces](../architecture.md). The derive is `corten`'s, so a client on `corten-protocol` alone
implements `Row` for its rows by hand.

## Which one

Corten has two kinds of push of its own, chosen by who keeps what is sent:

1. The server can draw the part: `<corten-live>`. A job's progress is a `<progress value max>`
   the stream draws again as the job moves; a growing log or a generated answer is a
   `view::Append(id, lines)` per piece, so each event carries only what is new.
2. A script keeps the data: a feed, whose rows are typed from the route to the script. One job
   followed by a script is a feed of one row, keyed by the job. A feed does not end on its own:
   the script subscribes with `AbortSignal.any([signal, done.signal])`, a controller `done` of its
   own beside the signal it was given, and calls `done.abort()` when the row says the job is done.

A stream in a format someone else defines (server-sent events a partner's client already reads)
is that protocol, not a page's, and the app writes it: a `Relay` of its own body
(`Body::from_stream`, `text/event-stream`). Corten adds none of what it gives its own streams,
so the app does three things itself:

1. Sends `X-Accel-Buffering: no` in the `Relay`'s headers and writes a comment line (`:`) on a
   quiet stream at least every 15 seconds, or a proxy in front holds the events back or closes
   the stream ([Deploying, Live streams](deploy.md#live-streams)).
2. Bounds it at shutdown. Corten does not end it when shutdown begins, as it does its own
   streams; its connection is closed after the longer of the app's grace and the deadline of the
   route's area or API (30 seconds unless set), past `docker stop`'s 10. Put the route in an area
   or API with a short `deadline`: the handler only has to return the stream within it, and a
   stream still open at shutdown is closed when that bound passes.
3. Accepts how an OpenAPI document lists it: a `Relay` is any answer of another service, and an
   app cannot describe it as `text/event-stream` instead.

A two-way connection is a protocol switch (`corten::upgrade`), the app guide's Other protocols.

Corten had a third, `corten::event_stream` of named JSON events a script read with
`EventSource`. Its names and data were strings at the seam, and nothing used it, so it was
removed ([#964 corten::event_stream is public, untyped at the seam and unused outside Corten's own tests: remove it before 1.0 or record what only it serves](https://github.com/corten-run/corten/issues/964)).
