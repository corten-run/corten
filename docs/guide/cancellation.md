# Cancellation

[Back to the guides](../../README.md#documentation)

Both sides use one idea, the web's `AbortSignal`: work belongs to something, and stops when
that thing ends.

In a browser handler, keep the original `signal` across an `await`. If an operation cannot take
it (for example `navigator.clipboard.writeText`), check `signal.aborted` after the await before
changing UI, dispatching an event or starting a timer. The same element may have left and
returned while the operation ran: `isConnected` alone does not identify that earlier lifetime.
CopyButton follows this rule; it cannot cancel the clipboard write itself.

| Where | The signal | Aborts when |
|---|---|---|
| a handler | the `signal` keyword: `on:connect={js::watch(signal)}` | the element with the `on:` leaves the page; pass it to `addEventListener`, `fetch`, `subscribe`, `read` and `mount`, which is the only cleanup |
| a `<form data-patch>` submit | the runtime's, per form | a navigation, so a late reply never patches the wrong page, and for a GET a newer submit of the same form (a submit made while a write is pending waits for it instead) |
| a client navigation | the Navigation API's `event.signal` | another navigation starts |
| a request on the server | `req.signal()`, or `signal: corten::Signal` as an extractor | the response was sent (`Abort::Responded`), the client left (`Disconnected`), or the deadline passed (`Deadline`) |
| a task of the app's ([`App::task`](app.md#tasks)) | its argument | shutdown began (`Abort::Shutdown`); `serve` then waits for it up to `App::shutdown_grace` |
| work a handler finishes ([`Signal::finish`](#work-that-must-finish)) | its argument | the request's signal aborted (the client left, the deadline passed), or shutdown began |
| a read started ahead ([`Ahead`](views.md#the-document)) | none: dropping it stops it | the handler answered without awaiting it, the client left, or the deadline passed |
| a layout read ([`LayoutRead`](views.md#the-document)) | none: dropping it stops it | the answer draws no layout (a redirect, a JSON answer), the page gave the value, or the client left; past the deadline it draws nothing |

On the server, work the handler awaits needs no signal to stop: Rust drops the handler's future
when the client leaves or the deadline passes. The signal is for what a drop cannot reach: spawned
tasks, blocking threads, queries running elsewhere. A read started ahead with `corten::Ahead` is
the exception among spawned tasks: dropping it stops it, so it needs none. A drop also cannot run
async cleanup, so a handler that holds something across an await (a lease it claimed, a lock in
another service, a reservation) puts the claim, the work and the release in `signal.finish(..)`
([Work that must finish](#work-that-must-finish)). State a pooled database connection keeps past
its transaction (a Postgres session advisory lock, a `SET` without `LOCAL`, a temporary table) goes
back to the pool with the connection when the handler is dropped, and the next request to take
that connection finds it, so a connection given such state closes when it is dropped
([a lock whose snapshot follows it](requests-and-forms.md#when-the-works-snapshot-must-follow-the-lock)). `App::deadline` (30 seconds unless set, `None` for
none) bounds the time to a response's start and answers 503 with the error page; streams run as
long as they need. It includes reading the request body, so an app that takes large uploads
raises it. A deadline that finds the handler waiting for more of the body is the client's 408
instead (the request had not arrived whole in time; a 413 while a body over its limit is read
past), and is warned of as the 503 is ([design.md, Choice 30](../design.md#choice-deadline-body)).
A client closing an HTTP/1.1 connection mid-request is seen at once (an integration test closes
the socket and waits for `Disconnected`). The deadline's timer starts only when a handler waits,
so a page rendered from memory registers none.

A connection `serve` accepted keeps one timer for its requests' deadlines once two requests of
its have waited, rather than making one a request: the first two requests to wait make their own,
the connection makes its timer at the second, and each after them sets the connection's again
and leaves it set ([design.md, Choice 77](../design.md#choice-deadline-timer)). A connection
whose only request waits, as a proxy that opens one for each request sends them, keeps none. A
deadline fires when it did. What an app can see of the kept timer:

- Every connection asks its allocator for 128 bytes more, and for 240 more from its second
  request that waited until it closes. Those are bytes asked for, counted by DHAT on the
  benchmark app built with `--cfg tokio_unstable`, not the memory a process holds: in a
  default build with jemalloc, the resident memory of 5,000 connections that had each
  answered one request read 8,471 to 8,473 bytes a connection without the kept timer and
  8,471 with it, so a connection may hold less than 128 more, or nothing more
  ([design.md, Choice 77](../design.md#choice-deadline-timer), cost 3). A connection that sits
  idle after its third request that waited, or a later one, is woken once, for nothing, when
  the time the last such request's deadline was set for comes.
- While any connection's timer is set (from that connection's third request that waited until
  the time its last such request's deadline was set for, 30 seconds after it by default), the
  runtime that serves it works out a timeout each time the runtime's driver parks (the wait
  for the next event, which one thread of the runtime makes when it has no work left): about
  190 instructions each time, whichever connection is served next. A server whose driver
  parks once a request pays that on every request: on one connection that never waits,
  beside an idle one that had waited three times, 1% more instructions and 4% more of the
  server's CPU time a request, about 0.7 microseconds (measured on one machine; no cycle run
  has read it). A busy server pays less of it, one park serving many requests, and an app that
  keeps a timer of its own waiting (a task that sleeps in a loop, a handler's timeout) paid it
  before this and pays nothing more.
- A test on tokio's paused clock (`start_paused`) that leaves a served connection open after
  three requests of its have waited sees the clock move to that time when nothing else is due,
  where it stood still before. A test that reads the clock closes the connection first or moves
  the clock itself (`tokio::time::advance`).
- `app.router()` served another way keeps no timer, and neither does a request a layer moved to
  another task: each of their deadlines makes its own, as before.
- A handler that serves a request on a runtime of its own, inside a connection `serve` polls
  (`block_in_place` and `block_on`), has that request's deadline wait on the timer of the runtime
  around it once two deadlines of the connection have waited, whichever requests they were. The
  deadline still fires on time while that runtime runs; if it shuts down first, the request is
  answered 500 where it would have gone on waiting to its deadline (a test serves such a request
  and shuts the outer runtime down).

Routes that start their answer later than pages should (an upstream that answers in minutes, a
report, large uploads) get a deadline of their own where they are mounted, so the rest of the
app keeps its short one:

| Requests to | Deadline |
|---|---|
| an API's routes | its own `Api::deadline`, else that of the nearest API around it that set one, else the innermost area around it that set `Area::deadline`, else `App::deadline` |
| an area's routes | the innermost area that set `Area::deadline`, else `App::deadline` |
| everything else | `App::deadline` |

```rust,ignore
App::new(url::router())
    .area::<Reports>(|reports| reports::area(reports).deadline(Duration::from_secs(120)))
    .api::<Proxy>(|proxy| proxy.route::<Compact>(post(compact)).deadline(Duration::from_secs(600)))
```

Each answers the same way past it: the 503 (the error page, or JSON under an API), or the 408
while the handler waits for the body, and `Abort::Deadline`. `None` removes it for those routes
only. A single slow route goes in an area or an API of its own.

## Work that must finish

A handler that claims something must give it back, and a dropped future stops between the claim
and the release. `Signal::finish` runs its work on a task that finishes even if the handler is
dropped, and the handler awaits it as it would the work itself. The work gets a signal of its own,
which aborts when the request's does (the client left, the deadline passed) or when shutdown
begins, so the slow step can stop early while the release after it still runs:

```rust,ignore
async fn check(signal: Signal, State(gate): State<Gate>, Params(at): Params<url::Check>) -> HtmlResult {
    let outcome = signal
        .finish(move |signal| async move {
            let lease = gate.claim(at.provider).await?;
            let outcome = tokio::select! {
                outcome = provider_request(&lease) => outcome,
                reason = signal.aborted() => Outcome::Cancelled(reason),
            };
            // Runs whether or not the client is still there, with the provider's Retry-After.
            gate.release(at.provider, &lease, &outcome).await?;
            Ok::<_, Error>(outcome)
        })
        .await?;
    ..
}
```

At shutdown the work's signal aborts with `Abort::Shutdown`, and `serve` waits for it, so a deploy
does not cut a release off either. While its client is still there the handler awaits the work,
and `serve` waits for that request as for any other, up to its deadline (with `deadline(None)`,
for as long as it takes): a slow step that ignores the signal holds shutdown that long. Once the
handler is gone, `serve` waits for the work after the app's tasks, within the same
`App::shutdown_grace`; past it the work is left to end with the process, and logged. A panic in
the work is the handler's while the handler awaits it, and is logged once it is gone. An app that
serves its router another way (its own hyper loop around `App::router`) runs the work to its end,
but it is not told of shutdown or waited for. The work takes what it uses by value (it is `Send +
'static`). Keep only what must finish in it: the rest of the handler is still dropped when the
client leaves, which is what stops it.

A step that stopping midway would lose (a paid call whose answer is not recorded yet) is not stopped
on the signal: the work checks the signal before it starts one, and bounds each with a timeout so
that one call, its record and the commit end within a grace set above them; a call cut off by that
timeout is the provider's idempotency key's to answer ([Work that must not run twice at
once](requests-and-forms.md#work-that-must-not-run-twice-at-once)).
