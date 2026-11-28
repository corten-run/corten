# Live data

[Back to the guides](../../README.md#documentation)

Corten has two ways to keep a page current, both over server-sent events.

## Fragments: `<corten-live>`

For server-rendered parts that change (a status line, a notification count), stream views:
`corten::live(stream)` turns a stream of rendered HTML into server-sent events, and
`<corten-live src>` swaps each fragment into the page by `id`, like a form's patch. No script of
your own; the stream closes when the element leaves the page. When the stream ends the element
stays as it is instead of reconnecting. A server shutting down ends its streams first, and those
browsers reconnect. A part that is only slow to read, and does not change once drawn, needs no
stream: the page's own handler answers it ([A slow part](#a-slow-part)).

A value that keeps changing is the next section's `corten::live_watch`.

A stream's headers go out before its fragments are rendered, and a fragment is text, so a form's
new submit key (`SubmitKey::field`) in one cannot make the stream private as it makes a page. A
stream whose fragments may draw a key is never `Public` and says `Cache-Control: private,
no-cache` itself, written by a middleware of its area (`Area::middleware`): its default
`no-cache` is not enough, since some CDNs keep an answer that says only `no-cache` or
`no-store`. It carries no CDN caching header (`CDN-Cache-Control`, `Surrogate-Control`, the others
[caching](app.md#caching) lists, or a name the deployment configures), and no edge rule caches
its URL whatever it says; otherwise a shared cache gives every visitor the same key
([forms](requests-and-forms.md#forms)). Under `corten dev`, a stream whose headers as sent have
no plain `private`, or carry one of those listed CDN headers, is logged when a fragment it gives
draws a key.

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
[`tests/live.rs`](../../crates/corten/src/tests/live.rs)); that counts each page's event, not its compression or its write
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
async fn batch_live(Params(at): Params<url::BatchLive>, State(jobs): State<Jobs>, since: LiveSince) -> LiveResponse {
    let id = at.id;
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
([read again](requests-and-forms.md)), and a slow part the runtime reads links to the page with
it read in ([A slow part](#a-slow-part)).

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

## A slow part

A part of a page that waits for a slow read (picks for the visitor, a report) and that the page
can go without at first is drawn waiting, and read once the page is on the screen from the page's
own route. One handler answers both: the route says `patches`, and its handler answers with
`req.patch_or_with(part, page)`. The part side runs only for the runtime's read of the part
(`Mode::Action`) and reads only the part; the page side runs for every other request and draws
the part waiting, with `ReadAgain::now(route)` inside the waiting element, whose id the part's
patch replaces.

The part closure receives the checked `corten::Action`, whose `patch` or `patch_with_status` builds
its answer. The page closure receives no builder and answers a full page or redirect.

```rust,ignore
// in the routes module: `picks` has the page read them in (the link a browser without
// JavaScript follows); other links to it are `url::Home::default()`
//   #[route("/", get = home, patches)] #[derive(Default)] pub struct Home { pub picks: Option<bool> }

async fn home(req: Req, Params(at): Params<url::Home>, State(shop): State<Shop>) -> HtmlResult<Patches> {
    req.patch_or_with(
        // the runtime's read of the part: the part alone, as a patch
        |action| {
            let picks = shop.picks_for_you();
            async move { action.patch(Picks { picks: &picks.await }) }
        },
        // the page: without the part, unless its address asks for it
        || async {
            let picks = match at.picks {
                Some(true) => Some(shop.picks_for_you().await),
                _ => None,
            };
            req.page(html! {
                // .. the rest of the page
                match &picks {
                    Some(picks) => <Picks picks={picks} />,
                    None => <PicksLoading />,
                }
            })
        },
    )
    .await
}

#[component]
fn Picks<'a>(picks: &'a [Pick]) -> impl Patch {
    html! { <ul id={PicksId}> for pick in picks { <li>{&pick.name}</li> } </ul> }
}

#[component(css)] // picks_loading.css, below
fn PicksLoading() -> impl Render {
    html! {
        <p id={PicksId} class={Waiting}>
            <span class={Finding}>"Finding picks for you..."</span>
            <a class={Show} href={url::Home { picks: Some(true) }} rel="nofollow">"Show picks for you"</a>
            // read at once from the page's own route, as a patch that replaces #picks, the
            // element the tag is in
            {ReadAgain::now(url::Home::default())}
        </p>
    }
}

// listed with the app's components, so its stylesheet is served
App::new(url::router()).components(&[.., PicksLoading])
```

```css
/* picks_loading.css: the line shows while a read is bringing the picks, the link otherwise, in
   one cell, so the swap moves nothing around them */
.waiting { display: grid; justify-items: start; }
.finding, .show { grid-area: 1 / 1; }
.finding { visibility: hidden; }
[aria-busy] > .finding { visibility: visible; }
[aria-busy] > .show { visibility: hidden; }
```

The runtime fetches the route with `corten: action` as soon as the page is on the screen (a full
load or a navigation), whether the tab is shown or not, and applies the patch it answers by id.
The handler runs once for the page and once for the part, and each run reads only what it draws.
The reads are a script module of their own, which only a page with such a tag loads, preloaded
with the runtime: a page without a slow part loads nothing for them. The element the tag is in
(the part: it needs an id, and the runtime logs a tag in an element without one) is
`aria-busy="true"` while the read is on its way, and a navigation away, or a patch that replaces
that element, stops the fetch, so the server stops reading. The read depends on that element
alone: a patch of anything else meanwhile (the next cell of a grid, a live row of the same list,
another part read first) neither stops it nor marks it. A part is read once; one that should be
read again later carries `ReadAgain::from` in its answer ([read again](requests-and-forms.md)). A
part a page, a form's patch, a script's `patch` or a `<corten-live>` fragment draws waiting is
read, at the pace those come (a fragment that draws the part again ends the read the one before
started), and so is one the answer to a part read again (`ReadAgain::from`) draws, at its
interval; one a part's answer draws waiting is marked failed instead, so reads do not chain. The
module counts as the part's answer's only the tags in that answer's markup, handed to its read
by the runtime as it parses it, before anything else can run, and kept by nothing after: a part a form's answer or a part read again draws in the same moment (both having waited
for one stylesheet) is read, even in place of one the part's answer drew or at its address, and
so are one at an address only a `<template>`'s content in the part's answer names and one your
script draws while the answer is drawn or its stylesheet linked (from the `focusin` of the focus it moves, or a custom
element's `connectedCallback`). A
read the browser cut short by keeping the page in its back-forward cache is made again when the
page is shown, if its part is still there; a page the browser prerenders reads its parts once it
is shown. A page whose head asks to be read again (`ReadAgain`) is read on its interval whatever
its parts' reads: when its `<main>` changed, it draws the part waiting again, which reads it
again, so give the page an interval longer than its slow part takes.

Two parts one read draws (four panels from one report) each take a tag inside its own element,
with the same address: the runtime reads it once, and the part side draws both in one patch. A
`<template>` is allowed in any element a part may be, so each can be a cell of a grid, a row of
a table or an item of a list. A shared read is as slow as all it reads, so each part waits for the
slowest: independent slow parts on one route share that one read unless the app gives each a query
field (`url::Home { part: Some(Part::Picks) }`), so each has an address and a read of its own. A
page in a `Public`, which shared caches give to anyone, answers its part to anyone too: a part
read for one visitor there (picks for the visitor on a cached home page) needs a route of its own
that says `patches`, named in its `ReadAgain::now`. Only the part closure gets the checked
builder (its `Action`); the page closure gets none and runs only for a request whose effective
mode is not an action, where `req.action()` is `None` too. `patch_or_with` picks the part
closure only in the request's effective `Mode::Action`; return a page or a redirect from the
other one. Debug builds refuse a marked patch that reaches a browser's plain request, with the
limits [Choice 58](../design.md#choice-plain-request-patch) lists
([#1532 A patch can be made without checking the request's mode: req.action() could hand out the only way to make one, as invalid_with's FormPatch does](https://github.com/corten-run/corten/issues/1532)).

Without JavaScript nothing reads the part, so the waiting part holds a link to the page's own
route with a query field its page side reads the part in for: no second route, and nothing of
Corten's own in the URL. The component's CSS hides the link, and shows the line saying the part is
on its way, only while a read is bringing the part: the runtime's part module marks the part
`aria-busy` then. A part that is a form a submit marks too has one mark, the latest's: whichever
marked it last takes it away when it ends, so a submit's answer drawn first shows the link while
the read is still on its way. So the link shows without JavaScript, when the runtime or
its part module (`part.js`) does not load or run, and once the read has failed, in every browser.
The module marks the part busy once the page is parsed, so the link is drawn for a moment on a
load before it. A part its read did not replace (offline, the server unreachable, an error page, a
page, a patch without it) is marked `data-corten-read-failed`, which the CSS may use to say so. A read the server redirects (a sign-in) marks it too, and the page
stays: its link, a navigation, follows the redirect, as without JavaScript, so a user typing
elsewhere on the page is not taken away. Only a patch that replaces or removes the part
answers it: a patch that leaves it where it was (an empty one, or one of other elements) marks it
too. One of a shared read's parts replaced or removed while the read
was on its way (a form's answer, a script) is not drawn over: the patch is not applied, and the
parts still waiting are marked failed at once, so their links show. A part that is itself a live
region around `<main>`, which a write's page draws in place with a new tag, has the new tag read
and the old read stopped, so an older answer never lands over a newer one, even one waiting for
the same stylesheet; a kept part whose attributes the page draws again keeps its busy or failed
mark, and a kept tag the page draws with another address (a form's page that switches the
account a part is for) is read at the new address, its old read stopped and an old failure
forgotten. Following the link costs
one page with the slow read in it: `?picks=true` waits for the read wherever it is opened, with
JavaScript too, so the link is `rel="nofollow"` and nothing else links there. A page with several
slow parts reads them all in under one field, and a data client, which gets the page side, asks
the same address for them. What the pattern costs is one field and the page side's branch on it
per page ([design Choice 44](../design.md#choice-slow-part-link)). The page is not streamed in
parts instead ([design Choice 7](../design.md#choice-whole-pages)): its status and headers wait
for its own reads, and the part waits for none of them. A part that keeps changing once drawn is
a `<corten-live>` stream (above).

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
(from `corten`). `Stock` must come from the declarations `corten::types` writes:
`FeedUrl<import("../types/app").Stock>` written there, `/** @import { Stock } from "../types/app" */`
(at any depth, `../../types/app`), or a `@typedef` of either as below, including renamed imports
and aliases of aliases. A local row typedef, an import from another module, or an undeclared
name does not compile: matching only the name would let the script invent the rows' shape.
Corten checks the import path, not the file, so leave `types/app.d.ts` to `corten::types`.
The declaration names the Rust type in the component's module (bring it in with `use` under
its declared name), so the parameter takes only a route whose rows are that type.
A `FeedUrl` Corten cannot read (`FeedUrl<Stock[]>`) is an
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
221 and 3; measured with the check in `scripts/smoke.mjs`, which holds the 3).

A stream that drops is reconnected by the browser after the feed's `retry` (1 s), and in Chromium
so is one whose connection is refused. An HTTP error ends `EventSource` for good, as a load
balancer's 502 does while the only instance restarts; `subscribe()` then listens again from its
cursor after a wait that doubles every second error in a row (1, 1, 1, 2, 2, 4, 4 s and on up to
30 s), and 1 s again once a stream opens. A snapshot that fails to load (an error, or an answer
that is not a snapshot), a page's first or one a `sync` asked for, is fetched again on the same
schedule and counts in the same row; a snapshot that loads starts the count again. With the
browser's first retry at 1 s and answers that take no time, the tries come 1, 2, 3, 4, 6, 8, 12,
16, 24, 32, 48 and 64 s after the cut, then every 30 s, where the 1, 2, 4, 8 and 16 s waits before
put them at 1, 2, 4, 8, 16, 32 and 62 s. In that model no outage up to 48 s is met by a later try
than before and many are met sooner (one of 5 s at 6 s, not 8 s; 20 s at 24 s, not 32 s), while
most longer ones are met 2 s later (60 s at 64 s, not 62 s); the time a request takes, a timer
that runs late and loading the snapshot come on top.

With 20 Chromium pages and a local server that answered every request 502 for 5, 8.5 and 20 s and
came back with a new epoch, the median page had the new snapshot 6.2, 12.3 and 24.4 s after the
cut at `074398815`, against 8.2, 16.2 and 32.3 s at `42b474017` (medians of two runs and of
three); after 90 s, the median of five pages had it at 94.2 s, against 92.2 s (one run each).
Each page sent the 502 responder 12 requests in the 90 s runs, against 7 (11 in the first minute
against 6 in one page's trace); by the schedule, a server that stays down then gets one every 30 s
once the wait reaches 30 s, from 64 s after the cut where it was from 32 s. The tries are not
spread at random: 2,000
clients of the feed's protocol (four Node processes of 500, not `subscribe()`), each reconnecting
to a `watchlist` instance on one CPU (its server code as at `42b474017`, on Docker Desktop), all
had a snapshot and an open stream within 0.64 to 1.41 s of starting together, by their processes'
clocks, and within 0.71 to 1.94 s when their starts were spread over 0.5 s (three runs each, the
first of each the slowest). Spreading cut each client's median time (157 to 248 ms against 450 to
534 ms after the first run) but not the time until the last one was current, so the runtime does
not spread them.

`corten-cluster` runs one feed across instances (Postgres outbox, a leased relay to NATS
JetStream). The integration tests use PostgreSQL 19 and NATS JetStream. The crate uses
async-nats 0.53 and SQLx 0.8 ([Choice 51](../design.md#choice-msrv) says why).
An app upgrading `corten-cluster` must set `async-nats = "0.53"` in its own `Cargo.toml` too:
`Cluster::start` takes its `async_nats::Client`.

**Keep TLS failover when upgrading.** In
[async-nats 0.53](https://github.com/nats-io/nats.rs/releases/tag/async-nats%2Fv0.53.0),
`add_root_certificates()`, `add_client_certificate()`, `tls_client_config()`, or a `tls://` URL
make TLS mandatory for the whole pool by default, including `nats://` URLs and reconnects.

- **Mixed TLS and plaintext:** Use `ConnectOptions::tls_optional()` and explicitly list each
  secure peer as `tls://` and each intentional plaintext peer as `nats://`.
  `require_tls(true)` and `tls_first()` both conflict with `tls_optional()` and must be
  removed before enabling it. In a mixed pool, `tls_server_name()` changes the name checked
  when TLS is used; it does not require TLS. A peer learned over TLS still uses TLS, but a peer
  learned over plaintext can be dialed in plaintext if its INFO does not require TLS, and a
  discovered alias of a `tls://` peer is not bound by that URL. So in a mixed pool also call
  `ignore_discovered_servers()` and list every endpoint explicitly. For an
  all-TLS pool, leave `tls_optional()` off and use `require_tls(true)` to require TLS explicitly.
- **Initial discovery over TLS:** When TLS starts after the first INFO, only lists received
  inside TLS count. Before nats-server 2.12, a single seed can connect without discovering
  failover peers. List multiple `tls://` endpoints, use `tls_first()` with `handshake_first`
  enabled on every broker, or upgrade the brokers to 2.12 or later.
- **Discovered IPs:** An IP can inherit the reporting server's verified DNS name, not its IP.
  Even on nats-server 2.12 or later, a seed configured by IP can connect while peers it
  advertises by IP are skipped by default. List those peers explicitly, set `tls_server_name()`
  to a name valid on every TLS peer, or use `verify_discovered_servers_by_ip()` with IP subject
  alternative names and a trust store dedicated to this cluster.
- **Discovered hostnames:** Have brokers advertise DNS names that match their certificates.
  By default the client verifies each peer against the hostname learned over TLS, not a
  configured list of names. Trust only the cluster's CA: give its PEM to
  `add_root_certificates()`, or set that root in a custom `tls_client_config()`. If you keep
  system or shared roots, use `ignore_discovered_servers()` with an explicit server list.

Before rollout, take the connected broker out of service in staging and verify that the
client reconnects to a peer over the intended transport and feed delivery resumes.

Cluster feed keys use literal [NATS subjects](https://docs.nats.io/nats-concepts/subjects):
nonempty dot-separated tokens without whitespace, control characters (NUL included), `*` or
`>`, and at most `corten_cluster::MAX_FEED_KEY_BYTES` (1,024) bytes. UTF-8 and several tokens
(`seller.42`) work. Corten follows the documented naming rules even where the broker is
more permissive. `Options::subject_prefix` follows the same rules, with a 255-byte limit
checked at startup. The key also fits the feed and outbox B-tree indexes on standard
8 KB Postgres pages without relying on compression.

At NATS's default 4,096-byte [`max_control_line`](https://docs.nats.io/reference/config/max_control_line),
a prefix set with `async_nats::ConnectOptions::custom_inbox_prefix` can be at most 2,729 bytes.
`Cluster::start` checks the generated reply inbox, including the client's dot and 22-byte
token, before touching Postgres. The budget reserves space for the longest supported publish
subject and its protocol framing. Stay with the default unless you need a longer inbox prefix.
NATS does not advertise the limit: if you change it, set `Options::max_control_line` to match
the lowest limit on any NATS server the client can connect to. Raise both to allow a longer
inbox prefix; this does not change the key or subject prefix limits.

`create_feed` and `begin` refuse invalid keys before doing SQL. Inspect the error with
`error.is::<corten_cluster::InvalidFeedKey>()`. `Cluster::feed` answers `None` without
querying Postgres, and the snapshot and live routes answer 404.

The relay logs and drops pending rows with invalid keys from an older version or external
SQL, then keeps publishing the remaining rows. Look on `corten::feed`
for the outbox row ID and key. The relay uses the existing `published_at` marker to take
the skipped row out of the queue; it did not deliver that patch. Ordinary pruning can remove
it. An older instance holding the relay lease can still stall on a bad row
until a new relay takes over ([Choice 63](../design.md#choice-cluster-feed-subjects)).

To replace an invalid key, write a new feed with a valid key using the app's current
committed data, and point clients and future writes at it. Do not rename queued rows or
try to replay the dropped patches.

Size the JetStream stream's `MaxMsgSize` and every eligible NATS broker's
[`max_payload`](https://docs.nats.io/reference/config/) for the largest serialized patch,
including NATS headers. Leave `MaxMsgSize` unlimited or set it to at least that size; keep
the same broker limit on all servers the relay can connect to. Both limits must at least
fit a reload marker for the longest feed key you use: the key's length in bytes plus up to
135 bytes of header overhead (1,159 bytes for a 1,024-byte key). The overhead is 65 fixed
bytes plus two copies each of the generation and sequence. Look on `corten::feed` for these cases:

- JetStream's per-publish `10054` acknowledgement logs `published reload marker: JetStream
  size refusal (10054); patch kept for inspection` at error level after a new marker is
  acknowledged and the row marked done. The log includes the
  configured stream and its current `MaxMsgSize` when the stream-info lookup succeeds.
  Raise the stream's `MaxMsgSize` or keep future patches smaller.
- A refusal before sending, from the client's cached `max_payload`, logs `published reload
  marker: refused by the connection's cached limit; patch kept for inspection` at error
  level after a new marker is acknowledged and the row marked done. The error includes
  the cached limit and the checked size including headers. Raise
  `max_payload` on every eligible broker if needed, or keep future patches smaller. After
  changing the broker limit, refresh the connections of all eligible relay instances as
  needed; use `relay active` to identify the lease holder and the NATS client's `max_payload()`
  on that instance to verify the advertised limit it is using. Corten never forces a reconnect.
- A broker can close the connection if it receives a publish over its actual `max_payload`.
  Its protocol error names no row, so the relay cannot use it to drop a patch on a shared
  connection. An unacknowledged publish follows the ordinary retry path (`relay standing by`
  on failure). A disconnect can interrupt other feeds and other users of the shared client.

The relay pipelines up to 256 ordinary patches in outbox-ID order (feed-sequence order
within a generation) and reads ready acknowledgements while sending. The relay uses one
NATS reply subscription while it holds the lease, with separate reply slots for each patch
or reload-marker batch. It closes the subscription when a batch is abandoned or the relay
stops. Missing acknowledgements do not build up reply registrations across retries, and
a late reply to an abandoned attempt cannot retire a row. At a tiny client
`subscription_capacity`, a pipelined burst can fill the queue and the client drops
replies. If some patch replies arrive but others time out, the whole selection is retried,
including rows JetStream already stored. This adds broker work even when JetStream
deduplicates by message ID within its configured window. The relay publisher then keeps
one patch reply outstanding at a time for its remaining lifetime, without opening more
subscriptions. It bounds each serial pass by the lease, retires acknowledged rows while
still holding it, and continues pending rows on later passes. No minimum
`subscription_capacity` above the NATS client's own requirements is needed.

Two failures can change the order JetStream stores:

- If a pipelined patch send or acknowledgement fails, all IDs selected for that attempt stay
  pending, even those already acknowledged. After a mid-batch disconnect, queued later
  patches of a feed can reach JetStream on the new socket before the earlier patch is
  stored on retry or a reload marker is stored in its place.
- If an individual patch is refused for size, the relay sends its reload marker after
  attempting the ordinary patches. JetStream can therefore store later patches before
  that marker even without a disconnect. If the marker is not acknowledged, its row
  stays pending while other acknowledged rows can retire; JetStream may already have
  stored the marker if only its acknowledgement was lost.

Corten followers can stay at their last applied sequence until an update arrives. They reload
committed state from Postgres on a feed-sequence gap or a marker ahead of them. This restores
the current state, not every missed delta. They ignore patches and markers at or behind their
current sequence in the same generation
([relay stream-order limit](../design.md#limit-relay-stream-order)).

The patch size-refusal logs include the outbox row ID, feed key, and patch body size (not
the headers). Inspect the row by its logged `id` before ordinary pruning removes it, without
printing the body:

```sql
SELECT id, feed, generation, seq, octet_length(body), created_at, published_at
FROM corten_outbox WHERE id = $1;
```

`published_at` does not distinguish an acknowledged patch from an acknowledged marker. Within
[JetStream's configured deduplication window](https://docs.nats.io/learn/jetstream/publishing#avoiding-duplicate-writes)
from first acceptance of the message ID,
a duplicate marker acknowledgement also retires the row, but logs
`duplicate reload marker acknowledgement`: a notification with that ID was
already accepted, and it could be the patch or the marker. A retry after the window can
store another patch or marker with that ID. Install the app's `tracing` subscriber before
`Cluster::start` to capture these diagnostics during startup.
The original patch stays in Postgres, including for replay.

The marker is an empty JetStream message with a `Corten-Reload` header carrying the patch's
sequence, on the same subject with the same generation and deduplication ID as the patch.
This lets followers reload committed state from Postgres even if it was the feed's last
patch. A follower still loading checks the marker against its snapshot and reloads if needed;
a ready follower behind the marker reloads and sends its live clients `sync`. A follower
first loaded after the marker reads committed state from Postgres. If a marker cannot be
sent or acknowledged, its row stays pending for retry while the relay retires the other
acknowledged rows. Each failed row takes one batch slot; a failed marker can stall the
queue when no row in a full batch (256 rows) can be retired. The marker sends and
acknowledgements share a deadline of half the lease from its last renewal, not half a lease
per marker. Consistently late acknowledgements can stall a full batch even when the markers
fit. When that deadline expires, look for `reload marker publish failed` with
`deadline has elapsed`. Check broker and database latency; if the relay needs more time,
increase `Options::lease`.

For size refusals, check `reload marker refused for size` for the feed key, marker size
including headers, and the applicable limit (the stream limit is reported when the lookup
succeeds). Raise the limit if it cannot fit the marker.
An affected loaded feed can otherwise stay stale until a later patch reveals the gap
or the feed reloads from Postgres.

Older followers ignore a same-generation marker as an invalid empty patch; they can stay
stale until a later patch reveals the gap. Upgrade or restart instances still serving stale
copies so they load from Postgres. Reconnecting the relay or reloading the browser alone does
not refresh those copies ([Choice 63](../design.md#choice-cluster-feed-subjects)).

In the failover
benchmark (200 clients, 50 writes a second, each instance killed and restarted under load),
every patch arrived in both committed runs: 777,600 of 777,600, and 800,000 of 800,000 with
clients back on the other instance after 1.1 s at the median (measured on async-nats 0.50,
`examples/listings-feed/results/failover-r1.json` and `failover-r2.json`). Those 200
clients are the benchmark's own Node client of the feed's protocol. When a stream is answered
with an HTTP error they wait 1 s, doubling to 30 s while the errors go on, and 1 s again once a
stream has opened (`subscribe()` doubles every second error, above), but they are not an
EventSource: they retry a failed snapshot on their own schedule and count a gap in `seq` as lost
rather than loading a snapshot, so they show what the server sends through a failover. Beside
them a Chromium page runs `subscribe()` itself through the same run, and it lost nothing either
(3,888 of 3,888 and 4,000 of 4,000, one snapshot each).

Behind nginx with more than one instance in one upstream with its passive health checks
(`max_fails`), streams can keep a restarted instance out, as the benchmark found; to avoid it, route
the app's stream addresses to an `upstream` of their own with `max_fails=0` on its servers, as
the benchmark's [`nginx.conf`](../../examples/listings-feed/bench/nginx.conf) does for
`/feeds/<seller>/live` (its location assumes a seller key without `/`; match your own routes).
nginx lets a server that failed back in through one trial request every `fail_timeout` and
clears its failures only when a trial ends well, and a stream does not end. With one upstream for
everything, an instance that had restarted could stay out of one nginx worker's upstream a trial
at a time, and once the other instance was killed that worker answered reconnects 502 itself
(`no live upstreams`, 406 lines from one worker over 16 s while the restarted instance was up).
In 1 of 11 runs at `e33484d44`, the Node clients' 237 timed reconnects (those that resumed
with a patch) took up to 17.3 s, as long as four failed tries on the 1, 2, 4 and 8 s backoff take,
and 60 more fell past the replay window and loaded a new snapshot (not timed). In 6 runs
at `389ec774d`, with the streams' own upstream, no Node client got an HTTP error, the slowest
took 1.3 to 1.6 s, and the median of the runs' medians went from 1.1 to 1.25 s: about half of
the reconnects after a kill first try the killed instance (150 to 152 stream connects timed out
a run). Every client caught up in every run, some through a snapshot.

`max_fails=0` turns off only the passive exclusion: nginx still sends a new stream to a dead or
starting instance and moves it to the next one after a connect error or timeout, under
`proxy_next_upstream`, while another server and a try (`proxy_next_upstream_tries`) are left and
before any byte is sent to the browser. A killed container's address often does not refuse a
connection, it does not answer, so the benchmark's streams use a 250 ms
`proxy_connect_timeout`, chosen for its local network; size yours for your own. That bounds only
the connect: it does not move a stream that has already opened, or bound an instance that accepts
and does not answer (`proxy_read_timeout` does, 1 hour in the sample). Where the load balancer can
check readiness or drain an instance before it stops, prefer that. nginx keeps idle upstream
connections by default, so keep them shorter than the app's header timeout as [Deploy](deploy.md)
says.

The runtime checks the envelope of what it is sent: a snapshot's `epoch`, `seq` and `rows`, and a
patch's `seq` and each change's `op` and `id` (and an upsert's `value`). An answer that is not a
snapshot (from a server of another version than the page's runtime, or a route that answers other
JSON) is a failed snapshot: logged and fetched
again after a backoff. A patch that is not one has lost its write, so the stream is closed and the
snapshot loaded again, after a backoff that doubles from 1 s while the patches after it are bad
too; neither reaches the script. The rows themselves are not checked: each is the feed's `Row`,
the server's own type, whose JSDoc the browser never sees ([design Choice 40](../design.md#choice-script-boundaries)).
A page left open across a deploy that changes `Row` keeps the script it loaded, and the new
server's snapshot gives that script rows of the new shape: if its `patch` throws on one, that
write is lost until the next snapshot (the stream's `seq` has moved on), and if its `snapshot`
throws, the snapshot is fetched again after the backoff. Keep a deploy's `Row` readable by the
script before it (a field added, not one renamed or removed), or reload the page when a
snapshot's shape is one the script does not know.
Next to the `JSON.parse` it follows, its cost was within a timing's noise in Chromium (patches of
1 to 100 changes).
`subscribe()`'s recovery from a gap in `seq`, a stream answered with an HTTP error, a failed
snapshot, a snapshot that is not one and a patch that is not one is checked in Chromium, Firefox and WebKit by `scripts/smoke.mjs`, and from a `sync`
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
