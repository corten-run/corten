# The app

[Back to the guides](../../README.md#documentation)

`corten::serve(App::new(url::router())).await` puts everything a production app needs around
your routes. Each default can be replaced in one line.

| Concern | Default | Override |
|---|---|---|
| Address | `HOST` (both loopback addresses, `127.0.0.1` and `[::1]`, so `localhost` answers at once however it resolves), `PORT` (`3000`) | environment; `corten::serve_on(listeners, app)` for listeners of your own (a Unix socket) with the same shutdown, `corten::serve_wrapped(listeners, move \|tcp\| acceptor.accept(tcp), app)` for HTTPS ([below](#your-own-listeners)) |
| Names it answers to | `localhost`, IP addresses; any other `Host` gets `421` ([below](#host-names)) | `HOSTS=shop.example,.shop.example` in the environment, or `Policy::host("shop.example")` |
| The document | none: each page brings its own, the app's layout component with the page in it (`req.page(html! { <Layout ..>..</Layout> })`); `corten new` writes the layout | the layout is the app's code ([views](views.md#the-document)) |
| Routes | a `#[corten::routes]` module: each route names its handlers, and `router()` is what `App::new` takes; every handler is checked when the crate compiles, there and in `Area::route` and `Api::route` (Corten's `get`, `post`, ...), so no route reaches the app unchecked | |
| What handlers share | nothing | `#[corten::routes(state = Shared)]` and `router(shared)`; `#[derive(Clone, FromRef)]` on `Shared` lets a handler take one part, `State<Market>` (each field's type once; `#[from_ref(skip)]` leaves a field out; `Clone` is the router's and `FromRef` the handlers', [design Choice 34](../design.md#choice-state-derives)) |
| What a route answers | its handler's return type: `HtmlResult` (a page, a patch, a redirect; failures are the error page) or `JsonResult<T>` (failures are JSON too; `Result<JsonResponse, JsonError>` for a status or cookie of the handler's own, or another server's answer passed on) | `Public<..>` around either for an answer that is the same for everyone, `NoStore<..>` (or `no_store` on the route) for one nothing may keep ([below](#caching)) |
| The client's address | the connection's peer; no `X-Forwarded-For` is read | a handler takes `ClientIp`; behind a proxy, `PROXIES=10.0.0.0/8` in the environment or `Policy::proxy("10.0.0.0/8")` ([below](#the-clients-address)) |
| Who is asking | nothing: no lookup runs | a handler takes `Caller<Viewer>` (`Viewer: Identify`), looked up only then, once per request ([below](#who-is-asking)) |
| A part of the app | none | `.area(admin::area)` for a `#[corten::routes(area = Admin)]` module: its routes under the prefix (a route outside it does not compile), with `.components(&[..])` for a stylesheet only its pages load and `caller = Staff` for who may use it ([below](#areas)) |
| Error pages | every [`Failure`](#error-pages) in a plain document, in the request's mode (page, swap or JSON), sent with `X-Robots-Tag: noindex`; the error is logged, and shown only under `corten dev`; right for an API or a first sketch; an app with a layout sets one, and a debug build warns once at startup when an app with a stylesheet has none | `.error_page(page, state)`: `async fn(Failure, Req, ..extractors) -> HtmlResult`, in the app's layout and for who is asking; `corten new` writes one that names each case |
| JSON-only routes | none | `.api(api::api)` for a `#[corten::routes(api = ApiRoot)]` module: every failure under the prefix is JSON, unknown URLs included, with no document ([below](#json-only-routes)) |
| WebSockets and relays | none | a handler takes `Upgrade` and returns its `websocket(..)` or `switch(..)`; `Relay` passes another server's answer on as it came ([below](#websockets-and-relays)) |
| Security | a CSP that allows Corten's inline tag (the import map) by hash (a nonce only when the layout or a handler asks for one) and requires Trusted Types, with only the runtime's policy, so no script writes markup from a string, a `Permissions-Policy` on each full document that denies 16 powerful features (camera, microphone, screen recording, location, motion sensors, installed fonts, idle detection, window placement, payment, and devices: USB, serial, HID, Bluetooth, MIDI), nosniff, referrer, frame and opener headers, a same-origin check on unsafe methods; forms go to this origin only | `.policy(Policy::new()...)`: another origin for scripts, styles, images, `fetch`, frames, fonts, or `.form_action("https://pay.example")` for a form (or a form's redirect) that hands the user to another site, `.trusted_types_policy(name)` for a third-party script's own Trusted Types policy, `.allow_feature(Feature::Geolocation)` for a feature the app uses; one part of the app's pages only: `Area::policy` ([below](#a-policy-for-part-of-the-app)) |
| Caching | static files and the runtime cached forever; everything rendered `private, no-cache` ([below](#caching)) | return `Public<HtmlResult>` (or `Public<JsonResult<T>>`) for an answer that is the same for everyone |
| Static files | component scripts and the components' stylesheets (one file, plus one per area that lists components and one per set of areas that list the same components) at content-hashed, immutable URLs; each script loaded by the pages whose handlers use it | `.assets(Static)`: `static/`, compiled into the program by `corten::assets::embed!` (a constant per file, `req.asset(Static::STYLE_CSS)`) and served the same way ([below](#static-files)); `/favicon.ico` answers the directory's `favicon.ico`, else its `favicon.svg`, cached a day, unless a route of the app's matches the path; `.components(&[..])`, `Area::components(&[..])` ([styles](styles.md#areas)) |
| Middleware of your own | none | `.middleware((RequestId, RateLimit))`: steps of the app's own, at one place in Corten's order; `Area::middleware`, `Api::middleware` for the requests at a prefix ([below](#your-own-middleware)) |
| Health | `/health/live`, `/health/ready` (always ready; a check that has not answered in 800 ms is `unavailable`, [below](#health)) | `.ready(\|\| async { db_ok().await })`, `.ready_within(Duration::from_millis(500))` |
| Work that lives as long as the app | none | `.task("refresh", refresh)`: started by `serve`, told when shutdown begins ([below](#tasks)); on a schedule, with tokio's intervals ([below](#on-a-schedule)) |
| Connections | a request's head (its line and headers) must arrive within 30 seconds of the connection opening or its last answer, or the connection is closed; it may be 32 KiB, with up to 100 headers, or it is answered 431 and the connection closed; a write that waits 60 seconds for room in the send buffer closes its connection; no limit on how many are open | `.header_timeout(d)` (`None` behind a proxy that buffers heads), `.max_request_head(bytes)`, `.send_timeout(d)` (`None` behind a proxy that reads answers as they come), `.max_connections(n)`: past it, connections wait to be accepted; connections are HTTP/1.1, so an app with live streams goes behind a proxy or CDN that serves HTTP/2 or HTTP/3 ([Deploying](deploy.md)) |
| Shutdown | Ctrl-C and `SIGTERM` (on Windows Ctrl-C, Ctrl-Break, the console closing and system shutdown), or the app's `corten::shutdown()`, tell the tasks, end live streams, close the listeners, let requests in progress finish and answers be written for the longer of the grace and the request's deadline (its area's or API's where that sets one; a connection still open then is closed), and wait for the tasks and for work handlers finish (`Signal::finish`) (5 seconds) | `.shutdown_grace(d)`; the platform's wait before it kills the process (`docker stop`: 10 seconds; Kubernetes: 30) above the longer of the grace and the deadline of every route whose requests should finish |
| Logs | errors, warnings and other `tracing` events at `INFO` and above to stdout, one line each, as `tracing-subscriber`'s `fmt()` writes them without targets (`2026-11-06T21:20:29.018154Z  WARN corten: ...`), in its colors when stdout is a terminal and `NO_COLOR` is unset; control characters other than a tab are escaped in every field, so request text cannot start a line of its own or send the terminal a command; spans are not printed (feature `log`, a subscriber of Corten's own with no dependency) | set your own `tracing` subscriber first (`tracing_subscriber::fmt().init()` for spans, filters such as `RUST_LOG` or JSON lines); `serve` then leaves it alone |
| Compression | pages per request (zstd, brotli, gzip), static files once at the highest levels, JSON held as bytes (`json::Raw`) once when it is sent again, live streams per event with the compression context kept, so a redraw costs what changed, and a `Media::stream` download per chunk the same way (zstd, else gzip, never brotli, which Playwright's WebKit on Windows holds back; feature `compress`; the Dockerfile `corten new` writes links zstd to the build image's libzstd, `ZSTD_SYS_USE_PKG_CONFIG=1`, rather than compiling its C sources, which cut a clean release build's time by about a third, so the server needs `libzstd.so.1` in the image it runs in; a build elsewhere compiles zstd unless that variable is set where pkg-config finds libzstd); a `Relay`'s answer goes on as the upstream sent it | |
| Installable app | off | `.pwa(Pwa::new(manifest))`: manifest, generated service worker, offline page |
| Languages | none | `.messages::<Msg>()`: `req.t()` and `req.lang()` follow `Accept-Language`, or the locale a page's URL names (a `Locale<Msg>` route field the handler gives `req.set_locale`, [Views](views.md#a-locale-in-the-url)); each page says its locale in `Content-Language` |
| Visitors' time zones | not known: dates are UTC unless a zone is given | `.client_zone()`: the runtime keeps the browser's zone in a `corten-zone` cookie, `Option<ClientZone>` reads its name and, with the `zones` feature, `req.zone()` gives it with its rules; `.zoned_dates()` (`zones` feature) also writes dates in it ([Views](views.md)) |
| Dev mode | when `CORTEN_DEV` is set (`corten dev` sets it): errors shown on the page, open pages reload after a rebuild, and the browser's console names a form control drawn with a value its own attributes refuse (a stored `250` under `step="100"`), which stops its form being sent, and a live region drawn inside another (`errors.form_message()` inside the kit's destructive `Alert`), which a screen reader may announce twice, and it warns of a closed `<dialog>` or popover that a rule inside `@media` or `@container` gives a `display` (a filters rail drawn in place from a breakpoint, or an open look written without `[open]`), which the components' stylesheet keeps hidden, with the rule for each, from `/corten/dev.js`, a module only a dev server serves | `.dev(bool)` |

`App::header_timeout` (30 seconds unless set) bounds what comes before a request: a client that
opens connections and sends its head slowly, or never finishes it, cannot hold them (an idle
keep-alive connection closes after it too). A clock of the server's own checks it a few times a
second, so a connection closes within a tenth of the timeout of it (at most a second either way). It applies to `serve`, `serve_on` and `serve_wrapped` alike (where a TLS handshake's time counts toward it), on
every listener. `App::send_timeout` (60 seconds unless set, nginx's `send_timeout`) bounds what
comes after: a write that finds the connection's send buffer full may wait that long for room,
or the connection closes, so a client that sends requests and stops reading cannot hold its
connection, and a live stream, a feed or a WebSocket to one ends rather than waiting on it. It
counts only while a write waits: a download whose reader keeps freeing room and a stream quiet
between events are not cut, though a reader that takes a little each minute can be, since the
system reports room only once a good part of the buffer is free. A TLS connection's last record,
written as it closes, is held to it too. The same clock checks it; with both timeouts `None`
(behind a proxy) the clock and its work per request are gone. Once shutdown begins, a connection
still answering has the longer of `App::shutdown_grace` and the deadline of the request it is
answering (the app's, or its area's or API's), then is closed (a long download too; the number
closed is logged). With the defaults that is 30 seconds, the deadline's, so a client that has
stopped reading can hold shutdown that long: past `docker stop`'s 10 seconds unless Compose's
`stop_grace_period` is set above it (Kubernetes' 30, `terminationGracePeriodSeconds`, leaves no
room either), or the deadline is lowered. An area with a long deadline (an hour for an import
job) holds shutdown that long only while one of its own requests is in progress; a page's
connection keeps the page's, and one whose request has not reached Corten yet (a first
request's head still arriving, or any request held by a layer of the app's, `App::layer`) has
the grace, then its request's deadline once known, or the longest if it is still not known when
the grace has passed. A route whose deadline is removed (`None`) has the longest. Keep the
platform's wait above the deadline of the routes whose requests should finish: one whose work
can be run again (the import) may be left past it, to end with the process when the platform
kills it. Only an app with an area or API whose deadline is not the app's keeps each request's,
about 50 instructions a keep-alive request (callgrind); in an app without one, which pays
nothing, every connection has the longer of the grace and the deadline. A switched connection
(a WebSocket) is told and not waited for.
`App::max_request_head(bytes)` (32 KiB unless set) bounds how large the head may be, a URL
included: one past it is answered `431 Request Header Fields Too Large` as soon as it passes, by
the HTTP server, with no body and none of the app's headers, and the connection closes (a client
still sending the rest may see it reset instead). With the limit raised above 64 KiB, a URL over
64 KiB gets 414. A request has at most 100 headers whatever the size.
`App::max_connections(n)` caps how many connections are open across the listeners (none unless
set, [design Choice 19](../design.md#choice-head-size)). Together they bound what clients that never
finish a request can hold: 4,000 connections each holding a head just under 32 KiB took
card-market from 3.4 to 225 MiB (measured, about 57 KiB a connection), and it was still at
211 MiB after they closed. That is glibc's allocator (Debian's, the Dockerfile's base) keeping
memory the app freed, and each further flood grows what it keeps. Eight floods of 4,000 30 KiB
heads in a row (a separate run, at `e751d127`, `--cpus 1 --memory 1g`, one run per allocator,
`docker stats` on Docker Desktop) reached at least 448 MiB during the last (sampled during
the 12-second hold) and left 419 MiB 35 seconds after it. The same floods with jemalloc
preloaded reached 239 to 275 MiB during each but left 31 to 81 MiB after each, with no climb
from flood to flood, which is how it was told from a leak (no allocation count was taken);
mimalloc left 146 MiB. glibc's `MALLOC_MMAP_THRESHOLD_=16384`
left 167 MiB, still rising about 18 MiB a flood
([#852 Memory a flood of unfinished request heads takes is not given back when the connections close, and each flood grows it further (217 to 464 MiB over eight)](https://github.com/corten-run/corten/issues/852)).
The same floods driven by `bench/fullstack/flood-memory.mjs` (three runs each, the cgroup's
`memory.current` 35 seconds after the last flood) left 406 to 455 MiB on glibc's allocator, and its
tunables did not stop it: two arenas or one left 382 to 452 MiB, and a 16 KiB mmap threshold 177 to
184 MiB, still climbing 20 MiB a flood. jemalloc as it comes left 118 to 139 MiB, since it returns
memory only while the app allocates (more than the earlier run's 45 MiB 35 seconds after the last
flood, taken by `docker stats` on a build of `e751d127`, for a cause not found; the sizing below
uses this run);
with its background thread
(`MALLOC_CONF=background_thread:true`) the same app idle went back to 7 to 11 MiB
([#1011 Design Choice 23's jemalloc default rests on one flood run each and CPU rounds on a shared desktop; brotli and glibc's own tunables were never measured](https://github.com/corten-run/corten/issues/1011)).
So an app that faces clients directly sets `max_connections` from its container's memory with
room to spare, sized from the peak repeated floods reach rather than the first: 187 to 197 MiB for
4,000 here with the background thread, about 48 KiB a connection (sampled a second before each
flood's hold ended). The Dockerfile `corten new` writes preloads jemalloc in the image's last
stage with that background thread and a 64 KiB thread cache, which keeps brotli's buffers between
responses ([design Choice 23](../design.md#choice-jemalloc-image)). An image of the app's own adds
the same three lines, before any `USER` line; removing them runs the app on glibc's allocator:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:65536
```

Behind a proxy that buffers heads, the proxy's own limit applies first (nginx: four buffers of
8 KiB, no line over one); it adds headers of its own (`X-Forwarded-For`, `X-Forwarded-Proto`),
so keep `max_request_head` a little above what the proxy lets through.
`App::deadline` (30 seconds unless set) bounds how long a handler may take to start its answer;
an area or an API with slower routes sets its own (`Area::deadline`, `Api::deadline`), so the
rest keep the app's. Past it the answer is a 503 (`Failure::TimedOut`), unless the handler was
waiting for the client to send the rest of the body: then the request did not arrive in time,
and the answer is the client's 408 (`Failure::Failed`, as a stalled upload's `?` gives), so a
client that stops sending a form is not told the server was slow. With the defaults the deadline
(30 seconds) comes before an upload's idle time (`Upload::idle`, a minute), so it is the deadline
that answers a stalled upload, with that 408. A deadline that passes while a body over an
`Upload`'s or a `pieces_up_to` limit is read past is the 413 that read gives. Only a request
`corten::serve` reads from its connection is marked as waiting for its body; through
`app.router()` served another way that deadline is the 503 (the 413 still holds). See
[Cancellation](cancellation.md).

```rust,ignore
let app = App::new(url::router())
    .error_page(views::error_page, db.clone())     // in the app's layout, for who is asking
    .middleware((RequestId, RateLimit))            // the app's own steps, in this order
    .components(&[TOKENS, OfferList])              // components with scripts or styles
    .area(|area| admin::area(area).components(&[SalesChart]))
    .messages::<Msg>()                             // the locales req.lang() follows
    .pwa(Pwa::new(Manifest::new("Shop", "Shop").icon(Static::ICONS_192_PNG, "192x192")));
corten::serve(app).await
```

The layout around `<main>` renders on full page loads only; a client navigation gets the
`<title>`, the page's head tags and `<main>`'s children. Every page carries a key hashed from the
caller its handler read (if any), the deploy and the layout that rendered it (where its `html!`
document is written), and when a navigation or a form answer arrives with a different key
(sign-in, sign-out, a new release, a page in another layout), the runtime loads the whole
document, so the layout is never stale.

## Host names

An app answers a request only when its `Host` is `localhost` (or a name under it, such as
`app.localhost`), an IP address, missing (HTTP/1.0, a test's `app().test()`), or a name the app lists.
Any other name gets `421 Misdirected Request` before routing: no handler, middleware, caller
lookup or error page runs. Otherwise a page on a name someone else controls could point that
name at this machine (DNS rebinding) and then use every route as its own origin, writes
included, since the browser treats the rebound page as same-origin. On loopback, where only this
machine can reach the app, that is the access model it would break, so the check is the default
rather than a setting to remember.

A deployed app lists the names it is served under, where the deploy sets `HOST` and `PORT`:

```sh
HOSTS=shop.example,.shop.example   # the domain, and (leading dot) every subdomain
```

or in code, `App::policy(Policy::new().host("shop.example"))`. Behind a proxy that rewrites
`Host`, it is the name the proxy sends. A health check that calls the app by an IP address, or
by `localhost`, is answered as before. The first refused name is logged, so a deploy that forgot
its name says why it answers 421. An app served under names it cannot list in advance (each
customer's own domain) says `Policy::any_host()` (`HOSTS=*`) and checks them itself. The check
compares one header with a short list.

## The client's address

A handler that needs the visitor's IP address (to pass it to an API whose limits are per client,
or to limit by it itself) takes `ClientIp`:

```rust,ignore
async fn sign_up(req: Req, ClientIp(ip): ClientIp, form: Form<SignUp>) -> HtmlResult {
    accounts.create(&form, ip).await?; // the API counts each visitor on its own
    req.redirect(&url::Welcome)
}
```

Without a proxy it is the connection's peer. Behind one, every request comes from the proxy, which
names the client in `X-Forwarded-For`; the app trusts that header only from the proxies it lists,
where the deploy sets `HOST` and `PORT`:

```sh
PROXIES=10.0.0.0/8,fc00::/7   # an address, or a network, per proxy
```

or in code, `App::policy(Policy::new().proxy("10.0.0.0/8"))`. A request from a listed address is
followed back through `X-Forwarded-For`, right to left, to the first address that is not a proxy;
anything further left is whatever the client wrote, so it is never read. A request on a Unix socket
counts as from a proxy when the app lists any. Only `X-Forwarded-For` is read, which every common
proxy sets: a proxy sets one of it and `Forwarded`, and reading the other would take what a client
wrote there. List only the addresses requests reach the app from through the proxy: a client that
can reach the app directly from a listed address can name any address it likes.

`ClientIp` tells who is asking, so a `Public` handler cannot take it, and an answer that read it is
private like one that read a `Caller`. Where the address cannot be known (a Unix socket and no
proxy, a listener of the app's own whose address is not a socket address, a test's request
without `.peer(..)`), `ClientIp` is a 500 that says why and `Option<ClientIp>` is `None`. A test
gives the request an address with `.peer(ip)` ([Testing an app](#testing-an-app)). The peer is at hand while
the request's own future runs, so a layer of the app's own that hands the request to another task
(`tower`'s `Buffer`) leaves it unknown past that layer.

Giving each request its connection's peer costs 44 instructions per request whether a handler
reads it or not (callgrind, release build, keep-alive requests to `serve_on` over TCP, the
difference between 1,200 and 200 requests over 1,000: 54,507 before, 54,551 after). It is not a
request extension: one more of those cost 497.

## Tasks

Work that is not a request's (a refresh loop on a timer, a queue consumer, a supervised child
process, a periodic flush) is a task of the app's, an async function of a `Signal`:

```rust,ignore
async fn refresh(quotas: Quotas, signal: Signal) {
    let mut every = tokio::time::interval(Duration::from_secs(120));
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            // Given the signal: it stops its slow reads there, and still finishes its journal write.
            _ = every.tick() => quotas.refresh(&signal).await,
        }
    }
}

let app = App::new(url::router(quotas.clone())).task("refresh", move |signal| refresh(quotas, signal));
corten::serve(app).await
```

Three things in the loop matter. `biased` polls the signal first, so no run starts once shutdown
has begun (`select!` otherwise picks among ready branches at random). A run in progress is
outside that `select!`, so the signal reaches it only if the run takes it: a step that can take
longer than `App::shutdown_grace` (a remote read with a 10 s timeout, a page of 25 calls) races
its slow awaits against `signal.aborted()` and returns at the first, where its writes are whole.
Corten does not race the whole step for it: a step dropped mid-write leaves half a write, and only
the step knows where it can stop. A task still running at the end of the grace is ended anyway.
With `MissedTickBehavior::Skip` a run that took longer than the interval is followed by one late
run, and then the interval's marks again: tokio's default, `Burst`, runs once for each mark
missed, back to back.

`serve` starts the tasks once it listens; `app.test()` and `app.router()` start none, so a test of the app does
not run them. On Ctrl-C or `SIGTERM` the signal aborts with `Abort::Shutdown` first, then live
streams end and the listeners close, and `serve` returns once requests in progress and the
tasks have finished, waiting for the tasks up to `App::shutdown_grace` (5 seconds unless set),
and then, within the same grace, for work handlers finish ([`Signal::finish`](cancellation.md#work-that-must-finish)).
A task still running then is ended and logged by name, so a stuck one cannot hold the process,
and so is one that panics; whether to restart it is the app's choice. A task that returns before
shutdown began (it could not reach its database, or gave up) is logged by name as well
(`corten: task "pricing worker" returned before shutdown began`), so the log tells a task that
stopped from one that runs. A task the configuration turns off is not registered at all (the task
does not read the configuration and return), and a task with work to do once (warming a cache
after the app listens) waits for the signal when it is done (`warm(&cache, &signal).await;
signal.aborted().await`), so only a task that stopped early is logged. The builder chain ends
before the switched tasks:

```rust,ignore
let app = App::new(routes).middleware(Stamp).area::<Admin>(admin).task("sales", sales);
let app = match config.pricing_worker {
    Some(settings) => app.task("pricing worker", move |signal| worker::run(settings, signal)),
    None => app, // the app's own log line says the worker is off
};
```

Work that must finish before the first request (a migration) is done before `serve`, not in a task.

### A queue a request fills

A worker for jobs that requests queue (a batch to price, a file to import) claims a job, works
it, and waits for the next. The queue (a claim with a lease, `FOR UPDATE SKIP LOCKED`, its renewal,
putting back the claims of a worker that died) is the app's storage and its SQL, kept in a module
of the app's own that every worker shares. The loop around it is a task:

```rust,ignore
async fn worker(jobs: Jobs, queued: Arc<Notify>, signal: Signal) {
    while !signal.is_aborted() {
        let wait = match jobs.claim().await {
            Ok(Some(job)) => {
                // A block of its own, so the work (and a connection it holds) is gone before
                // `finished`.
                let outcome = {
                    let work = jobs.work(&job); // made once: `select!` below would start it again
                    tokio::pin!(work);
                    let mut renew = interval(Duration::from_secs(2));
                    renew.tick().await; // the first tick is at once, and the claim is new
                    loop {
                        tokio::select! {
                            biased;
                            _ = signal.aborted() => break Outcome::Released,
                            done = &mut work => break Outcome::Done(done),
                            _ = renew.tick() => {
                                // One that fails or stalls keeps the lease it has (30 s).
                                if let Ok(Ok(false)) = timeout(Duration::from_secs(1), jobs.renew(&job)).await {
                                    break Outcome::LeaseLost;
                                }
                                renew.reset(); // the next a whole period after this one ended
                            }
                        }
                    }
                };
                jobs.finished(&job, outcome).await; // released for the next process, or put back
                continue;
            }
            Ok(None) => Duration::from_secs(1), // jobs another process queued
            Err(error) => {
                tracing::warn!(%error, "claiming a job");
                Duration::from_secs(5)
            }
        };
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = queued.notified() => {}, // the handler that queues a job calls `notify_one()`
            _ = sleep(wait) => {},
        }
    }
}
```

The job's work races the signal here, unlike a step above, because each write it makes is whole
(a transaction) and doing the job again is harmless: dropping it releases the claim, and the next
process prices the batch again. Work whose writes are not like that takes the signal instead.
`finished` and every write the work makes are fenced by the claim (`WHERE claimed_by = $1`), so a
worker whose lease ran out, after a lost renewal or between its last one and `finished`, writes
nothing, and the worker that holds the lease now writes the result. A job that failed and is put
back waits in the queue's SQL (a `run_after` the claim filters on, later with each attempt), not
in the loop, so one that fails at once is not claimed again at once. The idle wait is a `sleep`
from now, not an interval, which would tick at once after a long job. A test runs the task on a
paused clock with a signal from `Signal::task()`, whose `Shutdown::begin` aborts it as `serve`
does, and checks the job is released at once.

### On a schedule

A job at a mark on the clock (hourly at :15) is an interval that starts there; jobs that must not
overlap (they share a lock) are branches of one task's loop, which runs one at a time, and the
loop keeps what each did for the app's status page:

```rust,ignore
const HOUR: Duration = Duration::from_secs(3600);

/// The next time the clock (UTC) is `past` a multiple of `period` (`past` under `period`).
fn next_mark(past: Duration, period: Duration) -> Instant {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let into = (now + period - past).as_nanos() % period.as_nanos();
    Instant::now() + period - Duration::from_nanos(into as u64)
}

async fn models(models: Models, status: Status, signal: Signal) {
    let mut hourly = interval_at(next_mark(Duration::from_secs(15 * 60), HOUR), HOUR);
    let mut recheck = interval(Duration::from_secs(5 * 60)); // the first tick is at once
    hourly.set_missed_tick_behavior(MissedTickBehavior::Skip);
    recheck.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let job = tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = hourly.tick() => Job::Refresh,
            _ = recheck.tick() => Job::Recheck,
        };
        let (started, clock) = (SystemTime::now(), Instant::now());
        let outcome = match job {
            // Given the signal: its slow reads stop there, where its writes are whole.
            Job::Refresh => models.refresh(&signal).await,
            Job::Recheck => models.recheck().await,
        };
        let ran = Ran { started, took: clock.elapsed(), outcome };
        status.lock().expect("never poisoned").insert(job, ran);
    }
}
```

`App::task`'s documentation has it whole, run on a paused tokio clock (`start_paused`): three
hours in which each refresh is an hour after the last, at :15, and a refresh that overruns the
recheck's marks is followed by one recheck, not one for each; a test of an app's own schedule does
the same. Daily at 03:30 UTC is `next_mark(HOUR * 7 / 2, 24 * HOUR)`. Jobs in separate tasks that
must not overlap share a `tokio::sync::Mutex`.

The loop and the `Mutex` hold within one process. An app that runs as several (a blue/green or
rolling release while the old and the new both run, an app scaled out) runs each of its tasks in
each of them, so each runs the schedule. A lock does not fix that: the instance whose tick comes a
second after another's run ended finds it free and runs the job again. A job that must run once
across them claims its run in the store they share, a row for the job and the mark the run is for,
and runs only where the claim added the row:

```rust,ignore
const MINUTE: Duration = Duration::from_secs(60);

/// The mark a tick is for: the nearest `past + k * period` on the wall clock to when the tick was
/// due (`tick()` returns that), the same in every instance whose tick for it came early or late.
/// `now` is the task's wall clock (below).
fn mark_of(now: SystemTime, due: Instant, past: Duration, period: Duration) -> i64 {
    let at = now - due.elapsed();
    let at = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let (past, period) = (past.as_secs() as i64, period.as_secs() as i64);
    past + (at - past + period / 2).div_euclid(period) * period
}

/// Whether this instance runs `job` for `mark`: the first to claim it does, the others skip it.
/// `CREATE TABLE job_runs (job text, mark bigint, PRIMARY KEY (job, mark))`. `db` is the pool, or
/// a transaction's connection.
async fn claim(db: impl PgExecutor<'_>, job: &str, mark: i64) -> sqlx::Result<bool> {
    let added = sqlx::query("INSERT INTO job_runs (job, mark) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(job)
        .bind(mark)
        .execute(db)
        .await?;
    Ok(added.rows_affected() == 1)
}
```

`mark_of` takes the wall clock's time rather than reading it, since a test on a paused tokio
clock (`start_paused`) does not move the wall clock, and every tick would land on the first mark.
Every interval under a claim starts on the clock's marks, so all instances tick on the same ones:
`recheck` above starts at once, and under a claim it starts as `hourly` does,
`interval_at(next_mark(Duration::ZERO, 5 * MINUTE), 5 * MINUTE)`. Started when each process did,
two instances that tick either side of half a period name adjacent marks, and both run it seconds
apart. In the loop (the task given the pool, a wall clock `wall: impl Fn() -> SystemTime` that is
`SystemTime::now` in the app and, in a test on a paused clock, the time the test started plus
`Instant`'s elapsed time since, and `Job` a `name()` for its row), each tick gives when it was
due, and the job runs only when its claim says so:

```rust,ignore
let (job, mark) = tokio::select! {
    biased;
    _ = signal.aborted() => return,
    due = hourly.tick() => (Job::Refresh, mark_of(wall(), due, 15 * MINUTE, HOUR)),
    due = recheck.tick() => (Job::Recheck, mark_of(wall(), due, Duration::ZERO, 5 * MINUTE)),
};
// Raced with shutdown: a claim waiting for a connection would outlast the grace.
let claimed = tokio::select! {
    biased;
    _ = signal.aborted() => return,
    claimed = claim(&pool, job.name(), mark) => claimed,
};
match claimed {
    Ok(true) => {} // run it, as above
    Ok(false) => continue, // another instance has this one
    Err(error) => {
        tracing::warn!(%error, "claiming a run"); // the schedule goes on; this run is skipped
        continue;
    }
}
```

The claim gives at most one run for each mark. An instance that claims a run and stops before it is
done or fails (a deploy's shutdown, a crash, an error) leaves that run undone; a job that must not
miss one records what it finished, and the next run takes up what the last left, as the queue above
does. The table gains a row per run, so a prune of old marks belongs in the job. Each mark runs at
most once whatever the clocks say, since each instance names its own tick's mark. A clock ahead of
the others runs each mark early by as much, and when the instance that runs changes (one with a
faster clock starts, or it stops), the time between two runs is a period less or more that skew; a
skew near a period puts two runs moments apart. Keep the clocks in sync (NTP), which a short period
needs most. Across a release the claim holds only while the old and the new both claim and name the
job and its marks alike: the release that brings the claim in, or renames a job or moves its marks,
runs it in both while they overlap, so it goes out with the old drained first.

A claim keeps apart runs of one job for one mark, and nothing else: one job's run that overran its
period overlaps the next, and two jobs kept apart by one loop or one `Mutex` (the refresh and the
recheck above) run at once on two instances. Jobs that must not overlap, across instances, take one
lock for all of them before they claim, and a busy lock skips the tick with its mark unclaimed: a
mark whose every tick meets another job's run (jobs in separate tasks, every instance ticking while
it runs) is run nowhere, so a job that must not miss one records what it finished, as above. For
work of seconds that is the advisory lock in [Work that must not run twice at
once](requests-and-forms.md#work-that-must-not-run-twice-at-once), with the timeouts it sets there,
and the claim and the job's writes run on the lock's transaction (`held.conn()` in place of the
pool), so the job holds one connection and a run that fails rolls its claim back with it. Then an
instance whose tick for that mark comes later may run it again: the failed run's database writes
went with its claim, a call outside the database did not. For work of minutes it is the queue's
leased claim, renewed while the work runs.

Each instance's status (the map above) holds only the runs it claimed, so behind a load balancer
a status page shows a different last run from each. Status shown across instances is kept in the
shared store too: the run's row, given when it started, how long it took and how it ended.

Limits, which are the app's to handle:

1. The interval keeps time on the monotonic clock, which a change of the wall clock does not move
   and some systems stop while asleep (a laptop): after such a jump its marks are off the clock's
   until the interval is made again from `next_mark` (when a tick comes a period late, say).
2. The next run's time, for a status page, is worked out the same way; tokio's interval does not
   say.
3. UTC marks are the same local marks only in zones a whole number of hours from UTC. A wall time in
   a zone with daylight saving time (daily at 03:30 where the server is) takes a time-zone library
   (jiff, chrono-tz).

Corten has no scheduler of its own: a task and tokio's intervals are the one way.

## Health

`/health/live` answers while the process runs; `/health/ready` runs the app's check
(`App::ready`), so a load balancer or Kubernetes sends an instance no traffic while what it needs
is down. A check that has not answered in 800 ms is dropped and `/health/ready` answers
`unavailable`, inside Kubernetes' one-second probe timeout, and one warning is logged until it
answers again; `App::ready_within(d)` changes the limit, kept under the probe's own timeout.

With a database, set the pool's wait for a connection well under the app's deadline
(`App::deadline`): sqlx's `acquire_timeout` and Corten's deadline are both 30 seconds by default,
so with the database down every page that reads it waits the whole deadline and the visitor learns
nothing sooner. `PgPoolOptions::new().acquire_timeout(Duration::from_secs(5))` fails those pages
in 5 seconds. The readiness check needs no timeout of its own.

## Testing an app

A test asks the app as a browser would, through every middleware, area and error page and
without a socket: `app().test()` is a `corten::testing::Client`, and `corten new`'s tests use it.

```rust,ignore
let app = app().test();
let home = app.get(&url::Home).await;
assert_eq!(home.status(), 200);
let greeting = app
    .post(&url::Greet)
    .mode(Mode::Action)
    .field(GreetForm::FIELDS.name, "Ada")
    .await;
assert!(greeting.text().contains("Hello, Ada!"));
```

What it sends is what the app's own pages send, typed the same way:

1. The address is a route, or a `Local` path a test read from an answer (`answer.location()` after
   a redirect, an asset's URL in a page) or names on purpose: `Local::parse("/nope")` for the error
   page, a path Corten serves that has no route (`corten::pwa::MANIFEST_PATH`, `/health/ready`),
   or what a browser writes that a link does not. A route's address written as text does not
   compile.
2. A form is `.post(&route)` with `.field(name, value)`: the name is the form's `FieldName` and the
   value its type's (`5` for a `u32`, `Condition::Mint`, text for a `String` or an `Entry`). A
   value the type cannot hold goes through the name made untyped: a word the form refuses
   (`.field(f.condition.untyped(), "mint")`), the blank an empty number input sends. A form with
   nothing filled is `.post(&route)` alone. A `GET` has no fields; its query is the route's, and a
   GET form's checkbox (`?mine=on`, where a link writes `true`) is a `Local`.
3. A request asks for HTML as a browser's page load does. `.mode(Mode::Action)` asks as the
   runtime's `data-patch` submit does, `Mode::Navigation` as its link, `Mode::Data` as a client
   that wants JSON.
4. `.cookie(name, value)` sends a cookie (`answer.cookie(name)` reads one an answer set),
   `.header(name, value)` any other header, `.peer(ip)` the connection's address
   ([`ClientIp`](#the-clients-address)), and `Client::call(method, &route).body(type, bytes)` a body that
   is not a form (JSON, a multipart upload).

The answer is read to its end: `status()`, `headers()`, `text()`, `bytes()`. A live stream has no
end, so a test of one sends its request through `app().router()` and reads the stream as it comes
(with `tower = { version = "0.5", features = ["util"] }` for `ServiceExt` and `http-body-util` as
dev-dependencies: the one test that needs them).
Neither starts the app's tasks, so a test of a task runs its function itself with `Signal::task()`.
`corten check` runs `cargo test`, so it runs every test that is not `#[ignore]`d. A test is a
debug build, so a page it asks for that renders a component its area does not get, or one the
app does not list, answers 500 with why in the error page's `failure.detail()`, which the error
page `corten new` writes shows (so a status assert that prints the body names the component), and
prints it to stderr too: a test that asks for each screen (a step behind a query string included) checks them
all. A component no test draws is not missed for that: before the tests, `corten check` fails,
naming the file and line, for a component with a stylesheet, script or view that no array names
(`pub const COMPONENTS: &[Component] = &[..]`, `.components(&[..])` or a `vec![..]` passed to
it), by its name or a `use .. as` one, in its own crate or in a workspace member that depends on
it, directly or through another, so an app may list a shared crate's component, whether the check
runs at the root or in one member's directory. It reads each target's root and the files its
`mod x;` declarations name (not one only a test build has, a file `include!` brings in or a
module a macro declares), and any array outside markup and a
component's body counts as a list, so a name in an unrelated array can hide a missed one; a class
array in markup (`class={[Row, Selected]}`, a look's `[Tile, Raised]`) lists nothing. Which pages
get a listed one stays the app's choice, which a drawn page checks.

An app that calls another service over HTTP points it, in a test, at a stand-in started on a
local port. The stand-in is the other service, not the app, so it is axum's server, named
through `corten::axum`, and keeps none of the app's defaults (its headers, CSP, shutdown) that
the service does not have ([design Choice 21](../design.md#choice-own-extractors)):

```rust,ignore
let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
let origin = format!("http://{}", listener.local_addr().unwrap());
let stand_in = corten::axum::Router::new().fallback(platform).with_state(calls.clone());
tokio::spawn(async move { corten::axum::serve(listener, stand_in).await.unwrap() });
let app = app(Config { platform: origin }).test();
```

### Accessibility

`html!` refuses a name a screen reader would drop: `aria-label` or `aria-labelledby` on a
`<div>` or `<span>` with no `role`, or on an `<a>` with no `href`, does not compile, and neither
does an `<a>` named that way whose `href={..}` is an `Option` (a previous link at the first item),
which is no link when it is `None`. Name such a link by text in it,
`<span class={VisuallyHidden {}}>"Previous shipment"</span>`, which stays when the `href` does not.
(The rule is in [views](views.md#accessible-names).)

The rest (contrast, a scroll region a keyboard cannot reach, a missing label) is an audit's to
find in a browser. A page's CSP requires Trusted Types, so an audit script is not added to the page
as a `<script>` (Playwright's `page.addScriptTag` fails with "This document requires
'TrustedScript' assignment"), and the page's CSP need not be bypassed either: evaluate the script
in the page instead, which the CSP does not cover.

```js
import { readFileSync } from "node:fs";
const axe = readFileSync(new URL(import.meta.resolve("axe-core/axe.min.js")), "utf8");
await page.goto(url);
await page.evaluate(axe); // not addScriptTag, and no bypassCSP
const { violations, incomplete } = await page.evaluate(() => globalThis.axe.run());
```

Read `incomplete` too: axe puts some findings there that it could not decide alone (a prohibited
name on an element that also has text, a contrast over an image).

That runs in Chromium, Firefox and WebKit (axe-core 4.14 with Playwright 1.64, measured on the
ui-gallery's pages). Open each dialog, popover and menu before an audit, since what is closed is
not checked.

### In a browser

A link or a form the runtime follows changes the address when the page's answer is in, where the
browser lets a navigation say when its address changes (the Navigation API's `precommitHandler`),
and when the navigation starts where it does not; either way, before the new page is drawn. A
browser test that waits only for the address (Playwright's `page.waitForURL`) can read the page
it left: wait for something the new page draws as well (its heading, a row it lists).

```js
await page.getByRole("link", { name: "Orders" }).click();
await page.waitForURL("**/orders");
await page.getByRole("heading", { name: "Orders" }).waitFor(); // the new page, not only its address
```

### With a database

Corten has no database layer; the app's driver (sqlx, say) owns the connection, and tests follow
from how the app's code takes one. Code that writes takes the connection it writes on rather than
the pool, so a test can hand it a transaction:

```rust,ignore
// The app's write: a transaction in a handler, a test's transaction in a test.
pub async fn record_cost(db: &mut PgConnection, order: &Order) -> sqlx::Result<()> { .. }

async fn save(State(db): State<PgPool>, Form(order): Form<Order>) -> HtmlResult {
    let mut tx = db.begin().await?;
    record_cost(&mut tx, &order).await?;
    tx.commit().await?;
    ..
}
```

Then pick one of two ways to keep tests from leaving rows behind:

1. **A fresh database per test**: `#[sqlx::test]` (sqlx's `migrate` feature) creates one with the
   role in `DATABASE_URL`, which must be allowed to create databases, applies `./migrations`
   (`migrator`, `fixtures` or `migrations = false` for a schema the app does not own) and gives
   the test a pool or a connection; a passing test's database is dropped, a failing one's is kept
   for a look and dropped by the next run. Code that commits is tested as it runs, and tests do
   not see each other's rows. This is the one to reach for, and the one a handler test needs: a
   handler opens its transaction from the pool, so the test builds the app's state with the test's
   pool and asks `app(shared).test()` as above.
2. **A transaction per test, rolled back**: `let mut tx = pool.begin().await?;`, the code under
   test given `&mut tx` (its own transactions become savepoints), the result read on `tx`, and
   `tx` dropped or rolled back at the end. This works against a shared database (a dev copy) but
   cannot test code that commits on its own connection, and tests that write the same rows can
   deadlock under cargo's parallel threads (Postgres `40P01`). Tests
   that write the same rows take one lock first, `SELECT pg_advisory_xact_lock(hashtext('stock'))`
   on `tx`, released with the transaction.

`corten check` runs `cargo test` alone, so a test that needs a database the machine may not have is
`#[ignore = "needs DATABASE_URL"]`, and the app's CI runs `cargo test -- --ignored` with a
database. Such a test reads `DATABASE_URL` and fails with that name when it is missing rather than
panicking somewhere later.

The app is a library (`corten new` writes the routes, handlers and `app()` in `src/lib.rs`, and a
`main.rs` that only serves it), so a test target of its own, `tests/db.rs`, an example and a
second binary all reach the app's code. `cargo test --test db -- --ignored` runs the database tests
and nothing else. Something that calls a live service and writes files (a fixture recorder) is not
a test: make it an example (`examples/record_fixtures.rs`, run with `cargo run --example
record_fixtures`) or a binary, so no `cargo test` run, `--include-ignored` or not, starts it. An
app made before `corten new` wrote `src/lib.rs` (its modules declared in `main.rs`) moves them and
`app()` there; a module declared in both files is a second copy of its components, which fails
to build.

## Your own listeners

`corten::serve(app)` is `corten::serve_on(corten::listeners(3000).await?, app)`: `listeners(3000)`
binds `HOST`:`PORT` (both loopback addresses without `HOST`, port 3000 without `PORT`), and `serve_on` serves the app on anything
that implements `corten::Listener`, with `serve`'s shutdown across all of them
(tasks told, live streams ended, every listener closed and drained, tasks waited for). A Unix
socket, or a socket a supervisor hands over, is a listener of the app's own.

HTTPS is a step on each connection before HTTP, which `corten::serve_wrapped` takes: the TLS
handshake. TLS stays the app's choice of library, and so does its configuration. With
`tokio-rustls`, around the same loopback pair:

```rust,ignore
let mut config = server_config; // the app's rustls ServerConfig, from its certificate and key
config.alpn_protocols = vec![b"http/1.1".to_vec()]; // what Corten speaks (no HTTP/2: docs/design.md#limit-http1)
let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
corten::serve_wrapped(corten::listeners(3000).await?, move |tcp| acceptor.accept(tcp), app).await
```

The step is held to what a connection is. It runs in the connection's own task, so a client
that stalls in its handshake holds up no other; it counts against `App::max_connections` from
before the TCP accept; and `App::header_timeout` runs from the accept, so a client that never
sends its ClientHello, or never sends a request after the handshake, is closed at the same time.
A step that fails closes the connection, and shutdown ends the steps in progress. A listener of
the app's own that ran the handshake before `serve_on` saw the connection would have it outside
both limits.

An app behind a proxy that ends TLS needs none of this: `serve` is plain HTTP for the proxy
([Deploying](deploy.md) lists what the proxy must do).
The proxy is also where HTTP/2 or HTTP/3 to browsers comes from (Corten speaks HTTP/1.1), which an
app with live streams needs: over HTTP/1.1 a browser opens about six connections to a host, each
open stream holds one, and a page with a few live elements open in a few tabs uses them up. So
`serve_wrapped` facing browsers directly is for an app without live streams; an app with them
puts a proxy or CDN in front even though it could end TLS itself (why Corten does not speak
HTTP/2 itself: [design Limit 14](../design.md#limit-http1)).
An app whose own default port is not 3000 (another service has it on that machine) passes its
port, and `PORT` still overrides it: `corten::serve_on(corten::listeners(8320).await?, app)`,
rather than setting `PORT` from the program, which is `unsafe` once threads may be running.

## The request path

`App` is one middleware around the routes: the same-origin check, the request signal, the
deadline, the app's middleware, error pages, security headers and compression run in one future
per request, in a fixed order (`corten::middleware`). It is a tower layer of its own rather than axum's `from_fn`, which boxes the rest of the
stack again for every request (about 700 instructions). Corten's own inline tag (the import map) is the same on every page of a deploy, so the
CSP allows it by its SHA-256 hash, computed once at startup. A nonce is made only when something asks for one
(`req.nonce()` in the layout, or a handler that takes `Nonce`). A session lookup runs only for a
handler that takes a `Caller`, so static files, the runtime, the health checks and public pages
never touch the session store.

Measured with callgrind (instructions per request, release build, in-process `oneshot`; `bare
axum` is the same handler with no layers). "Three layers" and "one middleware" are one run each;
the last two columns are the median of 5 runs before and 4 after (range in parentheses), since
the same build moves by up to 2,000 instructions between runs:

| Request | Three layers | One middleware | Before caching | With caching | bare axum |
|---|---|---|---|---|---|
| small JSON handler under `App` (`Accept: application/json`) | 36,324 | 27,584 | 27,551 (27,381-28,007) | 28,255 (27,418-28,531) | 15,039 |
| the same handler under `.api("/api", ..)` | | 27,242 | 27,322 (27,136-27,371) | 27,578 (26,731-28,093) | |
| a small page, full document | 41,280 | 31,742 | 31,757 (31,728-31,814) | 30,912 (29,767-31,773) | |
| unknown URL, JSON 404 | 26,930 | 19,892 | 19,892 (19,876-19,943) | 20,218 (19,899-20,714) | |
| unknown URL, HTML 404 page | 37,130 | 29,325 | 29,325 (29,033-29,900) | 28,376 (27,182-29,333) | |

Caching adds one header lookup and insert to every response (`Cache-Control`) and two to read
the request's credentials: a few hundred instructions on JSON. Pages got cheaper, because a
page no longer makes a nonce (16 random bytes, base64, and the CSP string around it).

When the route's answer type, `Caller` and `Middleware` replaced the app's context and guards,
the same requests were measured before and after (callgrind, release build, in-process
`oneshot`, the difference between 1,200 and 200 requests over 1,000, median of three runs;
range in parentheses):

| Request | Before | After |
|---|---|---|
| a small page, full document, with a cookie | 24,021 (24,020-24,327) | 23,525 (23,514-23,555) |
| the same page without a cookie | 23,116 (23,075-23,116) | 22,614 (22,608-22,615) |
| JSON under `App::api` | 19,579 (19,579-19,758) | 19,307 (19,306-19,307) |
| unknown URL, HTML 404 page | 21,849 (21,832-21,987) | 21,125 (21,122-21,157) |
| a path that does not parse under `App::api` (JSON 400) | 27,657 (27,590-27,760) | 27,421 (27,322-27,857) |
| a handler that panics (error page) | 91,926 (91,891-92,015) | 87,631 (87,619-87,658) |
| a page whose handler reads who is asking (before: `App::context`) | 28,104 (27,938-28,237) | 26,315 (26,179-26,331) |
| a page that does not, on an app that can tell | 28,190 (27,843-28,312) | 23,538 (23,516-23,865) |
| a cross-site form post from a browser | 14,159 (14,159-14,165) | 21,339 (21,293-21,456) |

Two changes made with it account for most of the gain on every request: the security headers
reserve room only for what they add, so an error page's header map is no longer reallocated,
and the route is called without an `async` layer around it, which moved the request once more.
A lookup now runs only for a handler that takes a `Caller`. A cross-site post costs more
because a browser now gets the app's error page (`Failure::CrossSite`) instead of a bare 403.

When every route came to go through the same checks (`App::new` taking `Routes`, `Area::route`
and `Api::route` taking `Methods`), the same requests were measured again the same way:

| Request | Before | After |
|---|---|---|
| a small page, full document, with a cookie | 23,530 (23,454-23,882) | 22,954 (22,821-23,186) |
| the same page without a cookie | 22,738 (22,609-22,763) | 21,949 (21,946-21,995) |
| JSON under `App::api` | 19,306 (19,306-19,306) | 19,205 (19,202-19,205) |
| JSON from a routes module (`JsonResult`) | 20,027 (19,964-20,057) | 19,298 (19,287-19,350) |
| unknown URL, HTML 404 page | 21,099 (21,083-21,294) | 21,014 (21,000-21,016) |
| a path that does not parse under `App::api` (JSON 400) | 27,776 (27,742-27,784) | 28,268 (27,965-28,320) |
| a handler that panics (error page) | 87,566 (87,487-87,594) | 86,619 (86,615-86,753) |
| a page whose handler reads who is asking | 26,177 (26,163-26,200) | 26,288 (25,890-26,323) |
| a page that does not, on an app that can tell | 23,525 (23,466-23,885) | 22,902 (22,817-22,970) |
| a cross-site form post from a browser | 21,430 (21,313-21,450) | 20,883 (20,803-20,890) |

The checks happen when the app compiles, so nothing was added to the request path for them. The
JSON 400 costs about 500 more because the API's `get` is now Corten's (before, it was axum's),
which marks a JSON route's failed response with an extension, as a routes module's handler always
did, so the app answers it as JSON wherever the route is mounted. Profiled in an app with only
that route (26,781 before and 27,509 after, medians of three runs), almost all of the difference
is that insert: the extension map's allocation, growth and free, about 550 a request. Only a
failed response from a JSON route pays it. The other differences, a few hundred either way,
were not profiled; the cross-site post among them never reaches a route.

## Your own middleware

Every request goes through the same stages in the same order, outside in, each needing the one
before it:

1. Compression is negotiated (`Accept-Encoding`); it is applied last.
2. A write another site sent is refused (`Failure::CrossSite`). A browser's gets the error page,
   with the request's `Signal` made for it as in stage 3; its layout reads are not started.
3. The request gets its `Signal`, its nonce and the app.
4. The deadline and the panic catch start (`Failure::TimedOut`, `Failure::Panicked`).
5. The app's middleware, in the order given. The route has been matched, so axum's
   `MatchedPath` names it (it is absent for an unknown URL, and for a path under an API's prefix
   that a route outside the API matched, which answers with an empty `Allow` whatever its method). Then, for a request under an area's or an API's prefix, its own
   middleware: the areas' (outer first), then the APIs' (outer first), each in the order given.
6. The handler's extractors (a `Caller` is looked up here, only when read), then the handler.
   In an app with layout reads (`App::layout_read`, [views](views.md)), a whole document's `GET`
   starts them as a page route is called, or as a handler takes its `Req`, beside the handler,
   and a write that draws a page rather than redirect starts the reads its page draws once it
   has answered. Either way the page is filled with their values before its answer goes back out
   through 5: a middleware sees the filled page, and the time it measures around `next`
   includes the reads' wait ([design Choice 20](../design.md#choice-layout-reads)).
7. A failure becomes its route's answer: JSON for a JSON route or a data client, the app's error
   page for a browser. For a failure the request is at fault for (an unknown URL, a wrong method,
   a refusal other than a 429, a handler's `Refused` included, a request that does not parse),
   the error page starts the layout reads not started yet and waits for them, here, outside 5: a
   middleware sees neither the error page nor that wait.
8. Security headers, `Cache-Control` (private when anything read a caller), then the weak `ETag` on
   the answer to a `GET` or `HEAD` (outside an API and Corten's own paths), and
   `304 Not Modified` in place of the body when the client already has it
   ([design Limit 21](../design.md#limit-etag)), then compression. A middleware sees the `200` with the
   whole body, also when the client gets the `304`.

A step of the app's own is a `Middleware`, given once to `App::middleware`; several are a tuple,
run in order:

```rust
use std::time::Duration;
use corten::{extract::Request, http::HeaderValue, middleware::{IntoResponse, Response}, prelude::*};

struct RequestId;

impl Middleware for RequestId {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        let mut res = next.run(req).await;
        res.headers_mut().insert("x-request-id", HeaderValue::from_static("r-1"));
        res
    }
}

struct RateLimit;

impl Middleware for RateLimit {
    async fn call(&self, req: Request, next: impl Next) -> Response {
        if req.headers().contains_key("x-flood") {
            return Refused::too_many(Duration::from_secs(30)).into_response();
        }
        next.run(req).await
    }
}

let app = App::new(Routes::new()).middleware((RequestId, RateLimit));
# let _ = app.router();
```

Whatever a middleware answers (the 429 above) leaves through stages 7 and 8 like a handler's
answer, so it gets the error page (with the headers it set, `Retry-After` included), the security
headers and `Cache-Control`. One that turns a request away answers with a `Refused`
(`too_many`, `forbidden`, `unauthorized`, `unavailable`), which is answered in the request's
mode as a `Caller`'s refusal is: the error page for a browser, JSON for an API or a data client.
A middleware can
read a `Caller` the same way a handler does (`Caller::<Viewer>::from_request_parts`), and the
handler then reuses that lookup; `ClientIp::of(&mut req)` gives the client's address, as a
handler's `Option<ClientIp>` does. The tuple is resolved when the crate compiles, so nothing is
boxed: a middleware that only passes the request on costs about 230 instructions (its `async fn`
moves the request into its future), where axum's `from_fn` boxes the rest of the stack again
for every request (about 700).

Middleware that belongs to part of the app is given to that part, an area or an API, and runs for
every request at its prefix, never by a path the middleware compares. A request anywhere else
never meets it:

```rust
# use corten::{extract::Request, middleware::Response, prelude::*};
# struct WriteLimit;
# impl Middleware for WriteLimit {
#     async fn call(&self, req: Request, next: impl Next) -> Response { next.run(req).await }
# }
#[corten::routes(area = Items)]
mod items {
    #[route("/items")]
    pub struct Items;
}

#[corten::routes(api = ApiRoot)]
mod api {
    #[route("/api")]
    pub struct ApiRoot;
}

let app = App::new(Routes::new())
    .area(|area| items::area(area).middleware(WriteLimit))   // the item pages' forms
    .api(|routes| api::api(routes).middleware(WriteLimit)); // the partner API
# let _ = app.router();
```

Like an area's deadline and policy, its middleware covers every request at its prefix or under
it: its routes, its nested areas' and APIs' (the outer area's middleware runs first), an app
route declared at a path under it, and an unknown URL there. Given again, a middleware runs after what was given before. Each one a request meets costs
one boxed future on top of what it does (about 900 instructions for one that only passes the
request on). In an app where no area or API has any, the request runs the same code as before;
where some do, a request outside them pays a scan of their prefixes. card-market limits writes
this way.

A tower layer still goes around the whole app (`.layer(l)`), outside every stage, for what must
see the raw request first: a cap on body size.
There is no layer for one route: what a route needs is in its handler's arguments (an
extractor) and its return type.

## Static files

The app's `static/` directory is compiled into the program, so the binary is the whole deploy:
nothing beside it to copy, find at run time or keep in step with the build. `embed!` reads the
directory when the crate compiles and gives each file a constant (`icons/192.png` is
`ICONS_192_PNG`), and a page names a file by it:

```rust,ignore
corten::assets::embed!(pub struct Static = "static"); // from the crate's root

App::new(url::router()).assets(Static)
// in the layout:
<link rel="stylesheet" href={req.asset(Static::STYLE_CSS)}>
```

A misspelled or removed file does not compile. The PWA names its files the same way:
`Manifest::icon(Static::ICONS_192_PNG, "192x192")`, `Screenshot::new(Static::SHOTS_CART_PNG, "1280x720")`
and `Pwa::import_script(Static::SW_PUSH_JS)`; an icon another site serves is a `Uri`, as every URL
outside the app is. The manifest's other members are typed too: `display`, `display_override` and
`orientation` take enums, and the `id` and a `Shortcut` name a page of the app by its route
(`Shortcut::new("Watchlist", &Watchlist)`, with `icon` or `maskable_icon` as the manifest has).
A name that comes from data (a stored picture's path) is `req.find_asset(name)`, `None` when the
directory has no such file. Files are hashed when the app starts, and each is served from memory at
a URL with that version.

An edited file rebuilds the crate. A file added to the directory with no change to the code is in
the program from the next build that compiles the crate (a macro cannot ask cargo to watch a
directory); the Dockerfiles `corten new` writes touch every source before building, so a release
build has every file. `corten dev` reads the directory where `embed!` read it, so it serves a
new file at once, and an edit or a new file there alone restarts the app without compiling it
(a removed file, or any other change, builds). File
names are URLs, so they are letters, digits and `- _ . ~ @ + , = !`; another character is a
compile error. A program with two apps gives
each its own `embed!`. Dotfiles are left out.

Browsers still ask for `/favicon.ico` on their own for a document that names no icon (a PDF, an
image or JSON opened in a tab), and so do feed readers and crawlers. Corten answers that path
from the directory: its `favicon.ico` (`image/x-icon`) when it has one, else its `favicon.svg`
(`image/svg+xml`, the file itself rather than a redirect to its versioned URL,
[design](../design.md#choice-favicon-path)), each sent `public, max-age=86400` with its ETag, so
a browser asks again after a day and gets a 304. With neither it is a 404 with no body, sent
`public, max-age=3600` so an icon added later is seen within the hour, and never JSON, whatever
the client accepts or an API at `/`. Either way no layout read starts and no page is drawn. The file is chosen
when the app starts. A page or API route of the app's that matches `/favicon.ico` takes the path
instead, whatever its methods: one written as that path, or one with a parameter or a catch-all
(`/{*rest}`) that the router would pick for it. Every static file's ETag is compared as
`If-None-Match` is (weakly, a list or `*`), so a proxy that marks it weak still gets a 304.
The fixed icon uses a weak content tag that stays the same when its background-compressed
forms become ready; versioned files retain their encoding-specific tags.

## Caching

Static files, component scripts, the components' stylesheet and the runtime have content-hashed
URLs and are sent `public, max-age=31536000, immutable`; the PWA's worker keeps them. The icon at
`/favicon.ico`, a fixed path, is sent `public, max-age=86400` ([above](#static-files)). Everything
else `App` serves that does not set `Cache-Control` is sent `private, no-cache`: the browser
may keep it but asks again before using it, and no shared cache (a CDN, a proxy) stores it. A
page's layout may show who is asking, so a shared copy could show one user's page to another.

An answer that is the same for every visitor says so in its type, `Public<..>`:

```rust,ignore
async fn home(req: Req) -> Public<HtmlResult> {
    let page = req.page(html! { <Layout req={&req} title="Home">{view}</Layout> });
    Public::new(Duration::from_secs(60), page).stale_while_revalidate(Duration::from_secs(600))
}
```

Its handler may only take inputs that cannot tell who is asking (`Params`, `Form`,
`State`, `Req`, `Signal`, `Json`, ..., marked `Anonymous`), so a `Caller`, a `HeaderMap` or a
cookie in a public handler does not compile. Only a successful answer or a redirect is shared;
a failure keeps `private, no-cache`.

`max_age` is the browser's lifetime and every shared cache's. A page whose data changes slowly
(a catalog, a help article) can let a CDN keep it longer than a browser with `.shared(..)`, so the
origin renders it once a day instead of once a minute for each edge:

```rust,ignore
Public::new(Duration::from_secs(60), page).shared(Duration::from_secs(86_400))
// public, max-age=60, s-maxage=86400
```

The lifetimes are values, so one known only when the request is answered (an API's own
`s-maxage`, an operator's setting) is passed the same way. A response sent privately (the rows
below) drops `s-maxage` with `public`. `s-maxage` also forbids a shared cache to serve the page
stale (RFC 9111), so a shared cache that follows it serves neither of the stale directives below
on an answer with `.shared(..)`.

When the app is down, restarting, or answers 500, 502, 503 or 504 during a bad deploy, a cache
holding a recently expired copy serves the error unless the answer allows otherwise.
`.stale_if_error(..)` lets it serve the copy instead (RFC 5861), for up to the given time past
`max_age`:

```rust,ignore
Public::new(Duration::from_secs(60), page)
    .stale_while_revalidate(Duration::from_secs(600))
    .stale_if_error(Duration::from_secs(86_400))
// public, max-age=60, stale-while-revalidate=600, stale-if-error=86400
```

Both stale directives stay on an answer sent privately, for any private cache that implements
them (Chromium and Firefox implement `stale-while-revalidate`, not `stale-if-error`).

`App` still checks what it can see before it lets a shared cache keep the answer:

| The request or response | Sent |
|---|---|
| a full document, no `Cookie` or `Authorization`, nothing read a caller | as asked, plus `Vary: cookie` |
| a request with a `Cookie` or `Authorization`, or one whose handler or middleware read a caller | `private, no-cache` |
| a client navigation, a form answer or a data client's JSON from a page route | `private`, same lifetime: only the document is shared |
| a response that sets a cookie, or HTML with the request's nonce | `private, no-cache`, logged under `corten dev` |

A `Public` answer cannot set a cookie the way a private one does: the page inside
`Public<HtmlResult>` is made for everyone (`HtmlResponse<ForAll>`), and `with_cookie` on it does
not compile. `req.page`, `req.redirect` and the other `Req` methods take who the page is for from
where it goes, the handler's return type or `Public::new`, so a handler, a closure given to
Corten's `get` or `post`, and `Public::new(age, req.page(..))` are written as before. A helper is
where it shows: one that makes a page for a `Public` handler returns
`corten::Result<HtmlResponse<For>>` for any `For` (not `HtmlResult`, a page for one visitor,
which `Public::new` refuses: "is not an answer made for everyone, so it cannot be `Public`"), and one that
wraps a page in `Public` takes `corten::Result<HtmlResponse<ForAll>>`. A `Set-Cookie` header
written by hand is still caught when the answer is sent (the row above).

A `Cache-Control` written by hand (by a middleware, or on an `HtmlResponse`) is kept as written,
except that the last row applies to it, and a caller read makes it private. An extractor of the app's own is not `Anonymous` until the app says
so, so a public answer cannot read a credential through one by accident. An `App::api` route has one form only, so its public responses
stay public for clients without credentials. A cache in front of the app must key on `Vary`
(`corten`, `accept`, `accept-encoding`, `cookie` on an answer to a request without one, and
`accept-language` with `App::messages`, unless the handler took the page's locale from its URL); the [deploy guide](deploy.md#caching) names the setting for nginx, Cloudflare and CloudFront.
A `Public` page in an app with several locales is one copy per `Accept-Language` string in a cache that keys on it, and one language for everyone in one that ignores `Vary`: put its locale in its URL ([Views](views.md#a-locale-in-the-url)), so the cache keys on the URL alone.
`NoStore<..>` keeps an answer out of every cache, the browser's back/forward cache included:
`async fn statement(req: Req) -> NoStore<HtmlResult>`. A failure it returns is not kept either:
the error page for an expired code or someone else's statement goes out `no-store` too. In a
routes module the route can say it instead, `#[route("/statement", get = statement, no_store)]`,
and the handler keeps its own result: a handler that uses `?` (`async fn statement(req: Req) ->
HtmlResult`) is wrapped as it is, where `NoStore<HtmlResult>` would need its body moved into an
`async` block, and every handler the route names is covered, the failures each returns included,
and so is a request its extractors refuse before the handler runs (a path that does not parse, a
`Caller` that is not signed in). A route whose page is ordinary and whose write's answer
carries the secret (a new key shown once) names the methods instead,
`#[route("/account/key", get = page, post = rotate, no_store(post))]`: only `rotate`'s answers
and refusals are `no-store`, and the page keeps its usual caching (and the back/forward cache).
Use `no_store` in a routes module and `NoStore<..>` for a handler added by hand (`Api::route`,
`Area::route`). Two failures never reach either and get the default:
a handler that panics and one past its deadline; `NoStore<..>` also misses a request refused before
the handler runs. A handler
cannot mark an answer public any other way: a response it builds by hand is not an answer a route
can name, and if anything read a caller the answer is private whatever its header says.

A `Cache-Control` written by hand counts for what it plainly says: a `no-store` on any of its
lines, and a `private` only when the header is one line of plain text with no quoted value (with
more lines, a quoted value or a byte that is not text, a cache could read it another way) and no
`no-store` (`no-store=1` too) sits beside `must-understand` (a browser that knows the status
could still keep the answer). A directive with a value (`private="set-cookie"`, which lets a
shared cache keep the rest, or `no-store=1`) or inside a quoted value does not count, nor does a
`no-store` beside `must-understand` (with or without a value: a cache that knows the status may
ignore the `no-store`), which is left as written unless the answer is personal. A `no-store`
goes out where every reader sees it: several lines are joined into one, and beside a quoted value
or a byte that is not text it goes out alone (its other directives dropped, so no reader can find
anything else). A personal answer (it sets a cookie, read a caller, has the CSP nonce, or is a
`Cache` answer to a request with credentials) whose header does not count goes out
`private, no-cache`, or `no-store` if any reader could find one in its header.

An answer at a URL that names its content (a hash of its bytes, as an uploaded picture's can be)
never changes there. `Public::immutable(answer)` sends it as Corten's versioned files are sent,
`public, max-age=31536000, immutable`, and since the URL alone says what it is, a request's
cookies do not make it private and no `Vary: cookie` is added. A cookie it sets or a caller
something read still does. Its handler is held to the same rule as any `Public` handler. It takes
`Media` or `corten::Result<Media>` only: a page, a redirect or JSON changes with the deploy, so
`Public::immutable(req.page(..))` does not compile, and neither does a `PageOr<Media>`, which
may be a redirect. `Public::new` takes one, with the page inside made for everyone. A URL that does not name its content
(`/me/picture`) takes `Public::new` with a lifetime.

A header of the app's goes on a public answer with `Public::header`, named by a type: a file
that must stay out of search (`llms.txt`, a manifest), a canonical link. A download's file
name is the answer's own, `Media::attachment(name)`
(see [Requests and forms](requests-and-forms.md)).

```rust,ignore
use corten::answer::XRobotsTag;

async fn manifest() -> Public<Media> {
    let noindex = HeaderValue::from_static("noindex, nofollow");
    Public::new(Duration::from_secs(3600), Media::new("application/json", MANIFEST)).header::<XRobotsTag>(noindex)
}
```

The answer is compressed and shared as it would be without the header, which a `Relay` (another
server's answer, sent as it came) is not. Corten names `XRobotsTag`, `Link` and
`ContentLanguage`; an app names another with `impl
corten::answer::Header for ContentLocation { const NAME: &'static str = "content-location"; }`.
Which names a public answer may set is checked when the app builds (`cargo build` and `cargo
test`; `cargo check` does not evaluate it): `set-cookie` (the answer would be one visitor's), the
headers Corten sets itself (`cache-control`, a CDN's `cdn-cache-control` and
`surrogate-control`, which it would obey over Corten's, `vary`, the encoding and length, the
security headers, CORS's `access-control-*`, `corten-*`), those the answer has (`content-type`,
`location`, `content-disposition`) and the connection's (`transfer-encoding`) do not compile. Headers are added to a
success or a redirect; an error is the error page, without them.

A full document never carries `corten-page`, so if a cache hands one to a client navigation by
mistake, the runtime loads the URL as a whole page instead of swapping it in.

There is no page cache on the server. Rendering is the cheap part of a page: the measured
item page renders in about 15 µs and costs several times that to compress (see the
`render_cost` test), and a server cache's key would have to cover the caller, the locale, the
mode and the deploy, where a mistake shows one user's page to another. Cache the data a page
reads in the app, where it knows when the data changes, and let a CDN keep public pages.

A page route's answer to a `GET` or `HEAD` (the page, a navigation's swap, a patch read again, a
data client's JSON, a `Media` file) carries a weak `ETag` made from the body it rendered, its type
and its `corten-*` headers, and a request whose `If-None-Match` names it is answered `304 Not
Modified`: the answer is still rendered, but not compressed or sent. The browser keeps a `private,
no-cache` page and asks before reusing it, so this is what lets it reuse its copy: on a page loaded
again by a typed URL or a link without the runtime (every browser), and on a reload and the
runtime's navigations and prefetches (Chromium and Firefox; WebKit does not ask on those). Chromium
keeps one copy per URL, so after the runtime fetched a page's swap a reload names the swap's tag and
is sent the document whole, and the other way round. A `304` is the answer as the client has it,
whoever is asking, since the tag is the hash of what this request rendered; it still carries the
answer's headers and cookies. The runtime's headers count because a cache keeps a stored header the
`304` leaves out: a copy that came with a notice must not stand in for an answer without one. The
tag costs about 3 instructions a byte of a page (2.5 of a file), and a `304` saves the compression
and the body. With the `compress` feature, a client that accepts no compression and names no tag (a
benchmark, `curl`; every browser accepts one) is not sent a tag: it is not a browser keeping pages,
and for a page the hash would cost about a third of the render; a CDN that fetches pages
uncompressed therefore cannot revalidate them. Not tagged: a body with this request's nonce or a
form's new submit key (`SubmitKey::field`; either is never the same twice), an answer nothing may
keep (`NoStore`, or `no_store` on its route) or that is immutable, one with an `ETag` or an encoding of its own, a stream, a
relayed page, an error, a write and an API's answer. An answer compression sends as it is (a PNG, a
PDF, `no-transform`) is tagged as well: its `304` saves no compression, but the whole body. Without
the `compress` feature every client is sent a tag. A header of the app's own that only some answers
at one URL carry (`Content-Disposition`, `Link`) is not in the tag, and a cache keeps the stored one
on a `304`; send such a header on every answer at that URL, or none. The hash's key is made when the
process starts, so a tag from another process (a restart, or another instance behind a load
balancer) does not match and the page is sent whole ([design](../design.md#limits)).

## JSON-only routes

A page answers every request mode, so how it fails depends on what the client asked for: the
error page for a browser, JSON for `Accept: application/json`. A route with no screen (a
webhook, an OAuth callback, a call between services, a public API) is called by programs, and
most HTTP clients send `Accept: */*` or nothing. A handler that returns `JsonResult<T>` answers
every failure of its route as JSON, a path that does not parse included, wherever the route is.
Routes that share a prefix and its settings (cross-origin callers) go in a module of their own,
`#[corten::routes(api = ApiRoot)]`, whose `api` function `App::api` takes. Each route names its
handler, as any routes module's does, so an API route nobody serves does not compile; the
prefix's own route is the one that may name none:

```rust
use corten::prelude::*;

#[corten::routes(api = ApiRoot)]
mod api {
    #[route("/api")]
    pub struct ApiRoot;

    #[route("/api/items/{id}/price", get = price)]
    pub struct ItemPrice<'a> { pub id: &'a str }
}

async fn price(Params(item): Params<api::ItemPrice<'_>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "id": item.id, "lowest": "$0.50" }))
}

fn app(pages: Routes) -> App {
    App::new(pages).api(|routes| api::api(routes).allow_origin("https://partner.example"))
}
# let _ = app(Routes::new()).router();
```

A JSON answer is `200` with the value's JSON. One with a status or a cookie of its own is a
`JsonResponse`, made from the value (or from a `Relay`, [below](#websockets-and-relays)), and its
handler returns `Result<JsonResponse, JsonError>`:
`Json(started).with_status(StatusCode::ACCEPTED)` for a job begun,
`Json(session).with_cookie(SetCookie::try_new("session", &token)?)` for a sign-in (never a
`Set-Cookie` header by hand). That status and body are the app's own answer and reach the client
as written. A failure (`Err`) is answered in Corten's shape (or the API's own, `Api::errors`),
except a refusal in the app's own shape, below. A `JsonResponse` is for the client who asked, so
`Public` of one does not compile; a public JSON answer is a `JsonResult<T>`, and a refusal in it
is never shared (one that sets a cookie is private).

A refusal in the app's own shape (a document that does not exist yet,
`{"error":"No forecast yet"}` with a 503, or another server's error shape the route keeps) is an
`Err`: a `JsonResponse` converts into a `JsonError` (`JsonError::Own`, boxed so a helper's
`Result<_, JsonError>` stays small), so a helper refuses with `?`, and it is answered as written,
status, body and cookies. `Ok` is for the route's answers. Its status is a 4xx or 5xx: another
panics in a debug build, and in release is logged and answered as a 500. A route that keeps
another server's shape for a body it refuses too takes the whole `corten::extract::Request` and
reads the body with `corten::extract::bytes_up_to(request.into_body(), max)` (`None` when over
`max`), since `Json<T>` refuses before the handler in Corten's shape. Its `Err`, a body that could
not be read, says why (`error.to_string()`, the log's message) and with what status
(`error.status_code()`), so the route can answer that in its own shape too.

```rust
use corten::{http::StatusCode, prelude::*, JsonError, JsonResponse};

#[derive(ToJson)]
struct Problem<'a> { error: &'a str }

#[derive(ToJson)]
struct Batch<'a> { batch: &'a str }

fn refused(status: StatusCode, error: &str) -> JsonResponse {
    Json(Problem { error }).with_status(status)
}

fn created(request: Option<&str>) -> Result<JsonResponse, JsonError> {
    let id = request.filter(|id| !id.trim().is_empty()).ok_or_else(|| refused(StatusCode::BAD_REQUEST, "requestId is required"))?;
    Ok(Json(Batch { batch: id }).with_status(StatusCode::CREATED))
}
# let _ = created;
```

JSON the app already holds as bytes (a document built once when its data changes, a file sent as
it was written) is a `corten::json::Raw`: `Json(raw.clone())` sends the bytes as they are, with
no serialization and no copy. `Raw::new` reads them through once and returns an `InvalidJson`
error when they are not one JSON value in UTF-8 (a file saved in another encoding, or with a byte
order mark, included), so a corrupt file is an error the app handles, not a broken answer. Keep
the `Raw` and clone it for each request: with feature `compress`, one sent again is compressed
once, at brotli 9 and gzip 9, on one background thread that takes them in turn, and later reads
get those forms instead of compressing it per request (a client that ranks zstd higher still
gets zstd). Measured on a 79 KB document of two catalogue items, in a Linux container on a
desktop with other builds running (five runs, the coders alternating within each; the median of
the runs' medians, then the lowest and highest):
compressing it on every read takes 162 µs (116 to 197) with zstd 1 for 6,577 bytes, and 634 µs
(444 to 746) with brotli 1 for 7,284, where brotli 2 took 1,754 µs (1,516 to 2,153) for 6,939;
compressing it once at brotli 9 takes 17 ms (14 to 22), and each read then sends 5,655 bytes.
Counted by callgrind, a read is 0.73 million instructions with zstd 1 and 3.14 million with
brotli 1 (12.7 million at brotli 2), and the one compression 15.0 million. A `Raw` made for one
request is compressed as any answer is.

An endpoint built from a value rather than a function, the MCP endpoint (`agent::Tools`), is
added to its API with `Api::route`: `.api(|routes| mcp::api(routes).route::<mcp::Mcp>(tools.route()))`.
Corten's `get` and the others check its handlers as a routes module does.

When the endpoint's tokens come from an OAuth authorization server, `Tools::authorization` says
which one, as the MCP authorization spec asks of a server that checks tokens:

```rust,ignore
let authorization = Authorization::new::<mcp::Mcp>(&origin, "https://auth.example").scopes(&["inventory:read"]);
let audience = authorization.resource().to_string(); // https://cards.example/mcp
let tools = Tools::new("card-market", env!("CARGO_PKG_VERSION"))
    .authorization(authorization)
    .auth(move |headers| check_token(headers, &audience).ok_or(ToolError::Unauthorized));
```

Corten then serves the endpoint's protected-resource metadata (RFC 9728) at
`/.well-known/oauth-protected-resource/mcp`, the path RFC 9728 makes from the route's, and
every 401 from the endpoint names it:
`WWW-Authenticate: Bearer resource_metadata="https://cards.example/.well-known/oauth-protected-resource/mcp", scope="inventory:read"`.
A client that is refused reads the authorization server from there, gets a token for the
resource `https://cards.example/mcp`, and calls again. The token check takes only tokens
issued for that resource, as the spec requires: `Authorization::resource` is the one Corten
publishes, so the check and the document cannot disagree. With an `Authorization`, the check
runs once on every request to the endpoint, so a client without a token is refused at
`initialize` and learns where to get one before its session starts; any other failure of the
check answers too (400 for `Invalid`, a malformed token, 403 for `Forbidden`, 503 for `Upstream`
when the identity provider is down, 500 for `Internal`), so no method answers past it. An endpoint in an area (`Area::route`, behind
the area's middleware) has its metadata served the same way, outside the area. A call whose token lacks a scope answers
`Err(ToolError::InsufficientScope("inventory:read inventory:write".into()))`: a 403 with
`error="insufficient_scope"` and those scopes, so the client asks for them. The origin is the
one clients reach (from the environment, since it differs in each deployment); the path comes
from the route type, and one with a parameter or a trailing slash does not compile; mounting the
endpoint at another route panics at startup. The origin and each issuer must be `https` (or
`http` on `localhost` or a loopback address), checked when given. Without `authorization`, a
401 says only `Bearer`, for tokens handed out by hand, and tokens are checked per tool call as
before. Either way a 401 for a request that sent a token adds `error="invalid_token"`.

APIs nest as areas do, so each feature owns its JSON routes as it owns its pages. A feature's
module has a prefix under the app's (`/api/forecast-calibration` in `/api`), and both are
mounted:

```rust
use corten::prelude::*;
use std::time::Duration;

// The app's own API: here a relay of what has not moved yet.
#[corten::routes(api = ApiRoot)]
mod api {
    #[route("/api")]
    pub struct ApiRoot;

    #[route("/api/{*rest}", any = relay)]
    pub struct Rest<'a> { pub rest: &'a str }
}

// src/features/forecast/api.rs
#[corten::routes(api = Forecast)]
mod forecast {
    #[route("/api/forecast-calibration", get = report)]
    pub struct Forecast;
}

// The path as the client sent it, not the decoded `rest` (below).
async fn relay(Params(_): Params<api::Rest<'_>>, uri: corten::http::Uri) -> Json<String> {
    Json(format!("relayed {}", uri.path()))
}
async fn report() -> Json<&'static str> { Json("report") }

fn app(pages: Routes) -> App {
    App::new(pages)
        .api(|routes| api::api(routes).deadline(Duration::from_secs(15 * 60)))
        .api(forecast::api)
}
# let _ = app(Routes::new()).router();
```

The inner API keeps its routes, their checks and its `state`, and its own settings; what it leaves
unset (`deadline`, `errors`) it takes from the API around it, whose middleware runs before its
own. A setting the inner API gives replaces the outer one; `deadline(None)` removes an inherited
deadline, but nothing turns an inherited `errors` off: an inner API under an outer API with
`errors` writes its failures that way, not as Problem Details. Partner sites are the exception: an inner API allows only the origins it names itself
(`allow_origin`), so nesting a feature under a partner-enabled `/api` grants those partners
nothing, and a site both serve is named in both. No parameter or
catch-all route outside the inner API answers a path under its prefix: the outer catch-all
(`/api/{*rest}`) no longer answers `/api/forecast-calibration/old`, the inner API's 404 does, so
nothing under the prefix is relayed once the feature owns it. The same holds for every API and a
page's catch-all (`/{*rest}`): a path under the API's prefix is the API's 404, as JSON. A path is matched as the client sent it: `/api/forecast-calibratio%6E` is not under
the prefix, and an outer catch-all that relays it decoded reaches the old route, so a relay forwards
the path as it came. A route the outer API writes under the inner prefix (`/api/forecast-calibration/raw` in
`api`) does not start, and the message names the API it belongs in; a route of the app's own
written under an API's prefix is answered with that API's settings and middleware, so it goes in
the API. The same prefix
given twice does not start either.

A module costs nothing per request: its `api` function adds the same routes a hand-written
`Api::route` would. Measured with callgrind (instructions per request, release build, in-process
`oneshot`, the difference between 1,200 and 200 requests over 1,000, median of three runs;
range in parentheses), the item page's `/api/items/{id}` under an app with nothing else is
21,913 (21,816-22,228) added by hand and 21,836 (21,808-21,862) from its module.

Under the prefix:

1. Every failure is one JSON shape, whatever the client accepts: a Problem Details document
   (RFC 9457, `application/problem+json`), `{"title":"Not Found","status":404,"detail":"No item 7."}`,
   which clients, gateways and API tools read without knowing Corten. `title` is the status's
   reason, `detail` the message (left out when it would only repeat the title), and `type` is
   left out, which means `about:blank`: the status says what went wrong. That covers a handler's `corten::Error`, an
   extractor's rejection (a body that does not parse), an unknown URL, a wrong method (with
   `Allow`) and the deadline's 503. A 4xx message is sent, so write it for the client
   (`Error::new("no item 7").with_status(StatusCode::NOT_FOUND)`); a 5xx message stays in the
   log except under `corten dev`. A failure answered with a JSON body of the handler's own
   passes through, and validation errors are `Errors` as the error, which adds
   `"fields": {"email": "..."}`.
2. There is no document and no nonce, and responses are `private, no-cache` unless the handler
   returns `Public<..>`. The CSP is `default-src 'none'; frame-ancestors 'none'`. A handler
   that needs to know who is calling takes a `Caller` ([below](#who-is-asking)); a refused one
   is a JSON 401 or 403.
3. The deadline, the request signal, compression and the same-origin check on writes are the
   same as for pages; `Api::deadline` gives these routes a deadline of their own.
4. `Api::errors(|status, message| ..)` writes those failures in another shape, for an API that
   speaks another protocol's errors (an Anthropic- or OpenAI-compatible gateway, or an MCP
   endpoint's JSON-RPC errors, as `examples/card-market`'s `/mcp` answers them): it returns a
   `ToJson` value, so a key check in `Identify` and the API's unknown URLs, wrong methods,
   deadline and refusals all answer as its clients parse them. A `421` for a host the app does
   not answer is not the API's (no route ran), and a URL outside the prefix is the pages' 404.
5. `Api::allow_origin` lets one site's pages call these routes from the browser: Corten answers
   its CORS preflight, adds `Access-Control-Allow-Origin` and lets its writes through. The
   pages keep refusing that site's writes. The site authenticates with a token: a write from it
   that carries the user's cookies is refused, and no `Access-Control-Allow-Credentials` is sent.
6. `Json` in the prelude is `corten::Json` (feature `json`). It reads a request body into a
   `FromJson` (item 8) with the value and the rejections axum's `Json` gives: Corten's reader takes
   an `application/json` body, and axum (`serde_json`) any other JSON content type and any body
   the reader gives up on. What it writes is a `ToJson`: derive it
   (`#[derive(ToJson)]`, also in the prelude) on the response type, next to `Serialize` if other
   surfaces read it too. The derive lays the JSON out when the crate compiles, so a response
   copies one byte string between each pair of values instead of writing every key, quote and
   comma, into a `Vec` sized from the type's last response that the body keeps. It reads
   `#[serde(...)]` and writes the bytes `serde_json` would. A `#[serde(flatten)]` field whose type
   is a struct that derives `ToJson` is written in place, its members laid out the same way; an
   attribute it cannot follow (`flatten` of a map or an enum, `serialize_with`) does not compile. A field whose type has only `Serialize` (an id or a
   date from another crate) is written by `serde_json`. `serde_json::Value` is a `ToJson`, as above.
   axum's `Json` works too, and writes any `Serialize` through `serde_json` and a `BytesMut`.
7. Numbers are written as serde_json writes them, a whole float as `2.0`
   ([Numbers in JSON](#numbers-in-json)).
8. To read JSON another service answers, derive `FromJson` (in the prelude) next to `Deserialize`
   and read it with `corten::json::from_slice` or `from_str`. Corten's reader takes the fields the
   type declares and skips the rest; on anything it does not follow (an escaped key, a missing or
   duplicate field) `serde_json` reads the text instead, so the value and every error are
   `serde_json`'s. It reads `#[serde(...)]` as `Deserialize` does and refuses one it cannot follow
   (`flatten`, `deserialize_with`); a field of a type with only `Deserialize` is read by `serde_json`.

Each route is a `#[derive(Route)]` struct, and the API's prefix is one too (`ApiRoot` above), so
the router and the links name the same URL, and a route outside the prefix (`/apis/items`
under `/api`) does not compile rather than be served as a page. A handler that takes `State`
gets it on its `Methods`: `.route::<ItemJson>(get(item_json).with_state(source))`. `get`
(and `post`, ...) is Corten's, which checks the handler as a routes module does. An API
whose prefix is `/` makes the whole app an API (the health checks and the runtime keep their
behavior).

A screen that a native app or an agent reads is not an API route: it stays a page that answers
with `req.screen`, so every surface shares one handler (see [Surfaces](../architecture.md)).

### An OpenAPI document

An API's module names a route of its own, with no handler, where Corten serves an OpenAPI 3.1
document of its routes (feature `types`): `openapi = ApiDoc`. The document is generated from the
route table and the handlers' types, so a partner, a client generator, a gateway or a contract
test reads the contract the handlers enforce, not a copy beside them:

```rust
use corten::prelude::*;

#[derive(serde::Serialize, ToJson)]
struct Price { lowest: String }

#[corten::routes(api = ApiRoot, openapi = ApiDoc)]
mod api {
    #[route("/api")]
    pub struct ApiRoot;

    /// The OpenAPI document of these routes.
    #[route("/api/openapi.json")]
    pub struct ApiDoc;

    /// An item's lowest price.
    #[route("/api/items/{id}/price", get = price)]
    pub struct ItemPrice { pub id: u32, pub currency: Option<String> }
}

async fn price(Params(item): Params<api::ItemPrice>) -> JsonResult<Price> {
    Ok(Json(Price { lowest: format!("{} for item {}", "$0.50", item.id) }))
}
# let _ = App::new(Routes::new()).api(api::api).router();
```

`GET /api/openapi.json` then describes `/api/items/{id}/price`: an operation named after its
handler (`operationId: price`), summarized by the route's doc comment, with `id` a required
integer in the path and `currency` an optional string in the query, a 200 whose body is `Price`'s
JSON Schema, and a `default` response for every failure, a Problem Details document (or the API's
own JSON, with `Api::errors`). A `Json<T>` argument is the request body, with `T`'s schema as it
is read. Each parameter has its type's JSON Schema (a `#[derive(UrlValue)]` enum's words, one of
which it must be); a parameter whose type has none fails the document, naming the type, as a
body's does. It is required unless it is an `Option`, a list or has a serde default. Schemas are the ones
`corten::types` and MCP tools use, under `components/schemas`.

Every argument and answer of a handler in such a module says how it appears, checked when the
crate compiles, so no route is left out or described as less than it is. Corten's extractors and
answers do, a protocol switch's `Upgrade` and `Switch` and a stream's `since` and
`Last-Event-ID` included. An extractor of the app's own implements `corten::openapi::Argument`,
empty when the document has nothing to show of it (a session, a pool), with
`Operation::api_key("x-api-key", "..")` or `Operation::bearer("..")` for the credential it checks
(a security scheme of the document, which `Option<Caller<..>>` makes optional), or with
`Operation::header` for another header it reads; for another crate's type, a newtype around it
implements it. What the types cannot say is described as what it is: a `JsonResponse` or a
`StatusCode` is a 2XX the handler chooses, a `Relay` or a `Media` any content, a body the
handler reads itself any content, a `Form` or an `Upload` an object of fields, and a
`#[route(prefix = ..)]` family, which no OpenAPI parameter can name, is listed in the operation's
`x-corten-query-prefixes` ([design Choice 24](../design.md#choice-openapi)). An answer that can carry
a failure of its own adds it to its `default` response: JSON for a `JsonResponse` or a
`JsonResult` (its `JsonError::Own`), any content for a `Relay`. Two handlers with one name are named by route and method instead
(`item_price_get`). A route added by hand (`Api::route`, an MCP endpoint) is not in it.

The document is built once, when the router is, so a type in it with no JSON Schema fails then,
naming the type, and serving it costs a clone of its bytes. A test keeps a copy in the repository,
for a generator or a reviewer to diff, with `corten::openapi::sync`, which rewrites the file and
fails the test when the routes changed, as `Types::sync` does:

```rust,ignore
#[tokio::test]
async fn the_openapi_document_is_current() {
    let doc = app().test().get(&api::ApiDoc).await;
    corten::openapi::sync(concat!(env!("CARGO_MANIFEST_DIR"), "/openapi.json"), doc.text());
}
```

### Numbers in JSON

Numbers in a JSON response, a feed's rows and an agent tool's output are written as `serde_json`
writes them, whether by a `ToJson` or by `serde_json` for a field it hands on: the shortest digits
that read back as the same value, a whole float with its fraction (`2.0`, where JavaScript's
`JSON.stringify` writes `2`; Python's `json.dumps` writes `2.0` too), an exponent (`1e+16`,
`5e-6`) when the magnitude is at least `1e16` or nonzero and below `1e-5` for an `f64` (at least
`1e13` or nonzero and below `1e-6` for an `f32`, whose digits are the `f32`'s), where
`JSON.stringify` writes digits below `1e21` and down to `0.000001`, `-0.0` (where it writes `0`),
and `null` for NaN and infinity.

Both `2` and `2.0` are the number 2 in JSON's grammar, and RFC 8259 leaves how a reader types a
number to the reader; one that types it by its text tells them apart: Python's `json` reads a
float, `serde_json::Value` keeps them apart, and serde or Go reading into an integer field refuse
`2.0`. Keeping the fraction is what lets those readers type a float field the same way for every
value (with `JSON.stringify`'s form, `2` reads as an integer and `2.5` as a float). So:

1. A value the API's contract calls an integer (a count) is an integer field (`u64`), converted
   where the response is built, even when the app sums or scales it as an `f64`. `as u64` turns
   NaN, negative values and minus infinity into 0, and plus infinity or a value from `u64::MAX as
   f64` (2^64) up into `u64::MAX`, with no error, so check first:
   `(0.0..9_007_199_254_740_992.0).contains(&total)` refuses all of those and keeps a JavaScript
   client exact (past 2^53 a count is a string for one).
2. A parity test against the service a route replaces reads both bodies into the route's response
   type, or walks both `Value`s and compares numbers with `as_i64` or `as_u64` when both are
   integers and `as_f64` on both otherwise, and flags a field the old service sent as an integer
   that now arrives as a float: that field should be an integer type.
3. Text that must match another service's byte for byte is written by the app and sent as `Raw`,
   which is a `ToJson` and so can be one field of a derived response. `Raw` has no `Serialize`, so
   a type that feeds or agent output also write holds `Box<serde_json::value::RawValue>`
   (serde_json's `raw_value` feature; for agent output or generated types its schema is any JSON
   value). JavaScript's number form comes from
   `serde_json::Serializer::with_formatter` over a type that derives `Serialize`, with a
   `Formatter` whose `write_f64` and `write_f32` write it (`-0.0` as `0`, digits below `1e21` and
   down to `1e-6`, an exponent outside that), sent with `Raw::new`.
4. A checksum shared with other services is taken over canonical JSON (RFC 8785, which writes
   numbers the JavaScript way), not any serializer's output; Corten has no RFC 8785 writer, so that
   is a crate of the app's.

Handler arguments in markup are the exception: only the browser's `JSON.parse` reads them, so a
float passed for a `number` parameter is written as Rust's `Display` writes it, with no fraction on
a whole number and never an exponent (`JSON.parse` reads the digits as the same number), and NaN
and infinity as `null`. A value passed whole (an `any` parameter, a generated type) is written by
its `ToJson`, as above.

## WebSockets and relays

A route can switch its connection to another protocol, or pass on another server's answer, and
stay a route like any other: it is in a routes module, an area or an API, takes `Caller<T>`, and
goes through the host check and the app's middleware.

A WebSocket's handler takes `corten::upgrade::Upgrade` and returns what `upgrade.websocket(run)`
gives: the 101 with its `Sec-WebSocket-Accept`, and `run(stream, signal)` on the connection once
it has switched. Corten reads the handshake and hands over the bytes; the frames are a WebSocket
library's (`examples/watchlist`'s `/quotes` uses tokio-tungstenite):

```rust,ignore
async fn quotes(viewer: Caller<Viewer>, upgrade: Upgrade) -> corten::Result<Switch> {
    upgrade.websocket(move |stream, signal| async move {
        let mut socket = WebSocketStream::from_raw_socket(stream, Role::Server, Some(config)).await;
        loop {
            let message = tokio::select! {
                message = socket.next() => message,
                _ = signal.aborted() => {
                    let _ = socket.close(None).await; // shutting down: say goodbye
                    break;
                }
            };
            match message {
                // The library queued the answer to a client's close; a flush sends it.
                Some(Ok(Message::Close(_))) => { let _ = socket.flush().await; break; }
                Some(Err(_)) | None => break,
                // .. answer it; check the viewer again here if a revoked key must end the socket
                Some(Ok(_message)) => {}
            }
        }
    })
}
```

1. The handshake is a `GET` that carries the user's cookies with no CORS check, so it is held to
   what a write is: the app's own pages, a site `Policy::allow_origin` names (under an API, its
   `Api::allow_origin` sites too, without cookies), or a client that is not a browser. Another
   site's page gets a 403. A route whose callers must not be browsers at all refuses them in its
   `Identify` (a request with `Origin` or `Sec-Fetch-Site`).
2. A request that does not ask to switch gets a 426, and a route that does not take `Upgrade`
   never switches: only an `Upgrade` makes the 101, so a socket opens only where a route
   declared one. A URL that is a socket and also something else (a page, or a gateway's relayed
   answer) takes `Option<Upgrade>`, `None` when the request does not ask, and returns
   `SwitchOr<A>`: `upgrade.websocket(run)?.into()` or `SwitchOr::Answer(page)`. Its failures
   are answered as `A`'s are, and a switch it asks for is checked as above.
3. The request's own `Signal` ends with the 101, so the work gets its own, which aborts with
   `Abort::Shutdown` when the app begins to shut down; the work is not waited for.
   `App::send_timeout` still holds on the switched connection: a write the client has made no
   room for in 60 seconds fails with `TimedOut`, and the socket should end there.
4. Message size, compression, what may wait to be sent and per-message checks are the
   WebSocket library's settings and the route's code: Corten does not read frames.
5. `upgrade.switch(headers, run)` answers with an upstream's 101 and its headers instead, for a
   tunnel that relays another server's switch and then passes bytes both ways
   (`tokio::io::copy_bidirectional`).
6. Only HTTP/1.1 connections served by `corten::serve` switch; an HTTP/2 request (no extended
   `CONNECT`) and a test's `app().test()` get a 426.

`corten::Relay::new(status, headers, body)` is another server's answer passed on as it came,
for a gateway or a backend for a frontend: its status, its headers less the hop-by-hop ones, and
its body as it arrives (`Body::from_stream(res.bytes_stream())` from reqwest). A failure status
keeps the upstream's body, never the error page or the JSON error. The app's security and cache
rules still apply, except that a `Content-Security-Policy` the upstream sent replaces the app's:
a relayed page's scripts were written for its own policy (their nonces and hosts), which the app's
would block. Without one, the app's applies. A `Permissions-Policy` the upstream sent is kept the
same way, and a relayed page without one gets the app's
([below](#a-policy-for-part-of-the-app)). A streamed body is passed on as each piece arrives.
Corten compresses no relayed body, buffered or streamed, an event stream included, so a long
relayed stream holds no compression context: the encoding is the upstream's. A relay that should
be compressed forwards the client's `Accept-Encoding`, and the upstream's encoded body goes on as
it is, as long as the HTTP client does not decode it (for reqwest, leave its `gzip`, `brotli` and
`zstd` features off). When the client leaves, the body is dropped, and
the upstream request with it. What else to drop (`Set-Cookie`) is the route's to decide.

A route that answers some requests itself and passes the rest on (by method, body or tenant,
while it moves off another service; a cache in front of an upstream) names one answer for both.
A page route's is `PageOr<Relay>`, a page or the relayed answer. A JSON route's is
`Result<JsonResponse, JsonError>`: `Ok(Json(value).into())` for its own answer and
`Ok(relay.into())` for the upstream's, which stays the upstream's (its status, headers and
failure body, its encoding) as a `Relay` is anywhere. A route that only relays returns `Relay`:
its own failures (a path that does not parse) are then the error page, and it can be `Public`.
A JSON route that relays some requests is never `Public`, as no `JsonResponse` is, so a shared
cache keeps neither of its answers.

An app moved onto Corten a slice at a time serves its own paths and relays the rest to the
old server behind a catch-all route. `any = relay` serves every method there, those the app never
names included (`OPTIONS`, `PROPFIND`), so the upstream answers them, not Corten's 405. Corten
still answers what it answers for every route first: a write from another site is a 403, and
under an API that allows other origins a CORS preflight from one of them is Corten's (one from
any other origin reaches the old server, and the write after it is still refused). It is
the route's only handler, which the module checks when it compiles, so `any` is named in a
`#[corten::routes]` module (an area's or an API's as well) and has no builder for routes added by
hand. A path the app routes itself keeps only the methods it names: when the
old server still takes a `POST` where the app now serves the `GET`, name a relay for it there
too. A route with a parameter holds its handlers to taking its `Params`, so a handler cannot
ignore what the path says by mistake; for a catch-all that means the relay sees the paths its
`rest: &str` can read (one that is not UTF-8 once decoded is a 400). One relay for several
catch-alls is generic over the route, and the compiler picks the route at each name. A route
without a parameter has no `Params`, so it takes a handler without one, `any = relay_here`, that
calls the same forwarding code:

```rust,ignore
async fn relay<R: FromUrl>(_: Params<R>, req: Request) -> corten::Result<Relay> {
    legacy::forward(req).await // the old server's answer, as Relay::new(status, headers, body)
}

#[corten::routes]
pub mod url {
    #[route("/{*rest}", any = relay)]
    pub struct Elsewhere<'a> { pub rest: &'a str }

    #[route("/api/{*rest}", any = relay)]
    pub struct OldApi<'a> { pub rest: &'a str }
}
```

A catch-all outside an `App::api` does not reach under its prefix: with an API at `/api/v2`,
`/api/{*rest}` relays `/api/v1/..` and `/api/v2` answers its own unknown URLs with its JSON 404.
What the old server still serves under the API's prefix is relayed from the API's own module, a
`#[route("/api/v2/{*rest}", any = relay)]` there, so it meets the API's settings.

## Other protocols

Corten speaks HTTP/1.1 with pages, forms, JSON, server-sent events and WebSockets. Other
protocols and formats are the app's, and each has one place beside the framework, not a second
router merged after `app.router()` or a second server with a shutdown of its own: there they
would skip the host check, the app's middleware, `Caller<T>` and the grace that `serve` gives
requests and tasks.

1. A binary or XML body (Protobuf, CBOR, MessagePack, XML): a route under `App::api` whose
   handler takes the whole `corten::extract::Request`, reads the body with
   `bytes_up_to(request.into_body(), max)` up to the route's own limit, decodes it with the
   format's crate (`prost`, `ciborium`, `rmp-serde`, `quick-xml`), and answers
   `Media::new(content_type, bytes)`, or JSON. Its failures are the API's JSON (`Api::errors`
   for another shape). A body too large to hold (a file `PUT` to a store) is read as it
   arrives with `pieces_up_to(request.into_body(), max)` instead, under an API whose
   `deadline` leaves time for it (its idle time and minimum rate, not the deadline, are what
   give up on a client that trickles it in; a body read whole, by `bytes_up_to`, `Form` or
   `Json`, is bounded by the deadline alone, so keep one on those routes); a large upload sent
   as a form is `Upload`
   ([requests and forms](requests-and-forms.md)).
2. Webhooks a vendor sends: a `POST` route under `App::api`, as above, in a routes module
   without `caller =` ([Areas](#areas)). The signature covers the bytes as sent, so the handler
   reads them with `bytes_up_to`, checks the signature by the vendor's scheme, comparing it in
   constant time (the `hmac` crate's `verify_slice`), and only then parses them
   (`serde_json::from_slice`). A server's request usually has no `Origin` or `Sec-Fetch-Site`,
   so Corten's check of writes from other sites lets it through. A vendor that sends `Origin` is
   refused until an API allows it (`Api::allow_origin`), which opens every route of that API to
   the vendor's pages: give the webhook an API of its own (`/api/hooks`, nested in the app's) and
   allow the origin there alone. The signature is the check, and an `Identify` cannot make it,
   since it does not read the body. Vendors retry and deliver an event more than once: the
   handler records the event's id and answers a repeat as done, and answers quickly, leaving slow
   work to a task.
3. GraphQL, for an app that must offer it: a library such as `async-graphql` on a `POST` route
   under `App::api`, the body read with `bytes_up_to` and the response written as
   `Json(corten::json::Raw::new(bytes)?)` (which checks the library's bytes are JSON, one parse
   per response, since each is new). It is a second way to read what the screens read, which
   [architecture](../architecture.md#rules-that-keep-surfaces-from-drifting) keeps to one, a
   `POST` that no cache keeps (no `Public`), and the depth and cost limits of a query are the
   library's to set.
4. gRPC: `tonic` on a port of its own, in an `App::task`. It needs HTTP/2 end to end, which
   Corten does not serve ([design Limit 14](../design.md#limit-http1)), so it is not a route: its
   own interceptors check who calls it, and a browser reaches it only through a gRPC-Web proxy.
   Its port is bound before `serve`, as the example below binds its own, and served with tonic's
   `serve_with_incoming_shutdown` until the task's signal aborts.
5. A raw TCP or UDP protocol: a socket bound before `serve`, so a port that is taken stops the app
   at startup rather than leaving it ready without it, and handed to an `App::task`. It is bound
   where `main` builds the app, not in the function tests build it with, which then starts no task
   and binds no port. A TCP task accepts until the signal aborts, then stops listening and lets the
   connections it accepted finish within the grace (a task still running at its end is ended,
   [Tasks](#tasks)); a connection that lasts (a session of many requests) takes a clone of the
   signal and stops at the next request boundary once it aborts. A UDP task reads datagrams until
   the signal aborts.

```rust
use std::time::Duration;

use corten::{
    extract::{bytes_up_to, Request},
    http::StatusCode,
    json::Raw,
    prelude::*,
    Error, Media, Signal,
};
use tokio::{io::AsyncWriteExt, net::TcpListener, task::JoinSet};

/// The largest batch the route takes.
const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
/// The largest event a vendor sends.
const MAX_EVENT_BYTES: usize = 64 * 1024;
/// The largest GraphQL query the route takes.
const MAX_QUERY_BYTES: usize = 64 * 1024;

#[corten::routes(api = Ingest)]
mod api {
    #[route("/ingest")]
    pub struct Ingest;

    #[route("/ingest/batch", post = batch)]
    pub struct Batch;

    #[route("/ingest/vendor-events", post = vendor_event)]
    pub struct VendorEvent;

    #[route("/ingest/graphql", post = graphql)]
    pub struct Graphql;
}

/// A binary batch in, a binary receipt out.
async fn batch(request: Request) -> corten::Result<Media> {
    let body = bytes_up_to(request.into_body(), MAX_BATCH_BYTES)
        .await?
        .ok_or_else(|| Error::status(StatusCode::PAYLOAD_TOO_LARGE))?;
    // Decoded with the format's crate here: `prost::Message::decode(body)`.
    let receipt = (body.len() as u64).to_be_bytes();
    Ok(Media::new("application/octet-stream", receipt.to_vec()))
}

/// A vendor's event: the signature is checked on the bytes as sent, then they are parsed.
async fn vendor_event(request: Request) -> corten::Result<StatusCode> {
    let signature = request.headers().get("vendor-signature").cloned();
    let body = bytes_up_to(request.into_body(), MAX_EVENT_BYTES)
        .await?
        .ok_or_else(|| Error::status(StatusCode::PAYLOAD_TOO_LARGE))?;
    if !signature.is_some_and(|signature| verify(&body, signature.as_bytes())) {
        return Err(Error::status(StatusCode::UNAUTHORIZED));
    }
    let event: serde_json::Value = serde_json::from_slice(&body).map_err(|_| Error::status(StatusCode::BAD_REQUEST))?;
    // The event's id is recorded, so a repeat is answered as done; slow work goes to a task.
    let _id = event.get("id");
    Ok(StatusCode::NO_CONTENT)
}

/// The vendor's scheme: an HMAC of `body` with the app's secret, compared with `signature` in
/// constant time (the `hmac` crate's `verify_slice`). A stand-in here that refuses every event,
/// so a copy refuses until the real check replaces it.
fn verify(_body: &[u8], _signature: &[u8]) -> bool {
    false
}

/// A GraphQL query in, the library's JSON out.
async fn graphql(request: Request) -> corten::Result<Json<Raw>> {
    let _query = bytes_up_to(request.into_body(), MAX_QUERY_BYTES)
        .await?
        .ok_or_else(|| Error::status(StatusCode::PAYLOAD_TOO_LARGE))?;
    // The library executes the query here and writes its response.
    let response = br#"{"data":{"lots":[]}}"#.to_vec();
    Ok(Json(Raw::new(response)?))
}

/// A line protocol on a port of its own: each connection is told the app's name. Connections in
/// progress when the signal aborts finish, within the grace.
async fn hello(listener: std::net::TcpListener, signal: Signal) {
    let Ok(listener) = TcpListener::from_std(listener) else { return };
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => match accepted {
                Ok((mut socket, _)) => {
                    connections.spawn(async move {
                        let _ = socket.write_all(b"corten\n").await;
                    });
                }
                // Out of file descriptors, say: logged, and tried again after a pause.
                Err(error) => {
                    tracing::warn!("hello: accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
        }
    }
    // New connections are refused from here; those accepted finish.
    drop(listener);
    while connections.join_next().await.is_some() {}
}

/// The app, as the tests build it: no port, no task.
fn app(pages: Routes) -> App {
    App::new(pages).api(api::api)
}

/// The app `main` serves, with the protocol on its port, bound here, before `serve`: a port
/// that is taken stops the app as it starts. On `HOST` when it is set, as `serve` is (`0.0.0.0`
/// in a container), and on this machine alone otherwise (IPv4 here; `serve` also takes `::1`).
fn served(pages: Routes) -> std::io::Result<App> {
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let listener = std::net::TcpListener::bind((host.as_str(), 7070))?;
    listener.set_nonblocking(true)?;
    Ok(app(pages).task("hello", move |signal| hello(listener, signal)))
}
# let _ = app(Routes::new()).router();
```

## Who is asking

A handler that needs to know who is asking takes a `Caller<T>`, where `T` says how one is
found (`Identify`): a person by a session cookie, a partner by an API key. The handler's
arguments say what the route needs, and Corten answers for it in the request's mode:

```rust
use corten::{http::request::Parts, prelude::*, security::cookie};

#[derive(Clone, Hash)]
struct Viewer { name: String }

impl<S: Sync> Identify<S> for Viewer {
    async fn identify(parts: &Parts, _state: &S) -> Result<Self, Refused> {
        // A real app reads its session store here (`S` is the routes' state).
        match cookie::get(&parts.headers, "session") {
            Some(name) => Ok(Viewer { name: name.to_string() }),
            None => Err(Refused::sign_in(&url::SignIn)),
        }
    }
}

#[corten::routes]
mod url {
    #[route("/", get = home)]
    pub struct Home;

    #[route("/account", get = account)]
    pub struct Account;

    #[route("/sign-in", get = sign_in)]
    pub struct SignIn;
}

// "Sign in" or the name: the handler runs either way.
async fn home(req: Req, viewer: Option<Caller<Viewer>>) -> HtmlResult {
    let name = viewer.as_deref().map_or("Sign in", |v| v.name.as_str());
    req.page(html! { <Layout req={&req} title="Home"><p>{name}</p></Layout> })
}

// Someone signed in, or the browser goes to sign in: the handler never runs without one.
async fn account(req: Req, Caller(viewer): Caller<Viewer>) -> HtmlResult {
    req.page(html! { <Layout req={&req} title="Account"><h1>{&viewer.name}</h1></Layout> })
}

async fn sign_in(req: Req) -> HtmlResult {
    req.page(html! { <Layout req={&req} title="Sign in"><h1>"Sign in"</h1></Layout> })
}

#[component]
fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! { <html lang={req.lang()}><head><title>{title}</title><Corten /></head><body><main>{children}</main></body></html> }
}
# let _ = App::new(url::router()).router();
```

| `identify` says | Page, or a form post without JavaScript | Form patch | Data client, JSON route |
|---|---|---|---|
| `Ok(caller)` | the handler runs | the handler runs | the handler runs |
| `Refused::sign_in(&route)` | 303 to the route (`corten-location` to the runtime's fetch when the route is on another site or names a place) | `corten-location`, and the runtime goes there | JSON 401 |
| `Refused::unauthorized()`, `Refused::forbidden()` | the error page, `Failure::Refused` (401, 403) | the error page, swapped in | JSON 401, 403 |
| `Refused::too_many(wait)` | the error page, `Failure::Refused` (429), with `Retry-After` | the error page, swapped in | JSON 429, with `Retry-After` |
| `Refused::unavailable(error)` | the error page, `Failure::Unidentified` (503) | the error page, swapped in | JSON 503 |

1. Only a handler that takes a `Caller` pays for the lookup: a public landing page, static
   files and the health checks never touch the session store. Several readers in one request
   (a middleware, the handler and the error page) share one lookup.
2. Reading one makes the answer private (`Cache-Control: private`) and puts the caller in the
   page's key, so after signing in or out the runtime loads the next page in full and the layout
   shows who is asking now. A `Public` answer's handler cannot take one: that does not compile.
3. A refused request never reaches the handler's later extractors: the body is not read and
   nothing is written. Refuse with `Refused::unavailable` when who they are cannot be known
   now (the session store is down), so no one is sent to sign in again for nothing.
4. Callers of different kinds are different types with their own lookup: `Caller<Viewer>` from
   a session cookie on the pages, `Caller<Partner>` from an `X-Api-Key` header on a
   `JsonResult` route, where a missing key is a JSON 401. A type that is a rule over another
   (staff is a viewer with a role) reads the other in its `identify` with
   `let Caller(viewer) = Caller::<Viewer>::find(parts, state).await?;`, so the session is read
   once in the request whichever of the two the handler, a middleware and the error page take.
   The page's key takes each caller's value, not its type, so a rule that holds only the viewer
   (`Seller(Viewer)`, or `Staff<R>(Viewer, PhantomData<R>)` for a rule per permission) keys a
   page as the viewer does: a navigation between a `Caller<Staff<Intake>>` page and a
   `Caller<Staff<Returns>>` page for one person swaps `<main>` instead of loading the document
   in full. A rule that holds more (the org it acts for, a role) is keyed by that too, so a
   layout that draws it is never kept for another, and a rule that refuses is keyed by its
   type, so a layout that reads rules as `Option<Caller<Staff<R>>>` to draw a link per
   permission is keyed by which ones passed. Because a caller is keyed by its data, caller types
   that mean different things should hold data that differs: `Viewer(5)` and `Tenant(5)` hash
   alike, so a type whose ids can equal another's hashes a tag of its own as well (a hand-written `Hash` that writes a constant before the id).
5. A sign-in page whose handler needs a caller would send the browser round in a loop; Corten
   answers it with a 500 instead, and under `corten dev` the page says why.
6. Signing in and out set the cookie on the answer:
   `Ok(req.redirect(&url::Home)?.with_cookie(SetCookie::new("session", &token)))`, and
   `SetCookie::remove("session")` to sign out. `new` panics on a value a cookie cannot carry,
   which suits a token the app made; for one from elsewhere (another service's session token),
   `SetCookie::try_new` returns an `InvalidCookie` the handler maps to its own answer (a 502,
   say; `?` alone is a 500). `SetCookie` (`corten::security::cookie`) makes
   `HttpOnly; Secure; SameSite=Lax; Path=/` the default, and an answer that sets a cookie is never
   stored by a shared cache. A JSON sign-in sets it the same way, `Json(session).with_cookie(..)`.
   Never append a `Set-Cookie` header by hand.
   A return address the sign-in page was given (`?next=/account/cart`) is text from outside:
   `corten::Local::parse(&next)` keeps it only when it is a path on this site (not `//host`,
   `/\host`, a `..` segment or a full URL, so the redirect cannot lead elsewhere; nor a
   percent-escaped letter, digit or `-._~`, which a browser may ask for as another path), and
   `req.serves(&local)` says whether the route the router picks for its path (the app's own or
   an area's, not an API's) has a `GET` handler. Send the user to it with `req.redirect(&local)`.
   A path another app of the product serves is that app's address with the path after it
   (`Uri::try_from(format!("https://shop.example{local}"))`), and anything else goes to a page of
   the app's own.
7. `.message("Invalid API key")` on a refusal is what a client that reads the failure is told:
   the JSON error's message (in the API's own shape, `Api::errors`). The error page a browser
   gets does not show it, and a 503 from `Refused::unavailable` never sends its error. Counting
   failed attempts is the app's (by address or account, in its own store); `Refused::too_many`
   is how the lookup says the count is reached, checked before the credentials so a locked-out
   client learns nothing about them.
8. A check that depends on the record (only the author may edit a draft) stays in the handler,
   which loads the record, and refuses as a lookup does: `Err(Refused::forbidden())?`. That is
   answered as an extractor's refusal (the error page at 403, the layout's reads drawn as for a
   404, a 429's `Retry-After` kept), where `Error::status(StatusCode::FORBIDDEN)` is a failure that
   may be the app's own (a service that is down, answered with a 4xx), so its error page starts no
   layout read.
9. Test it the way a user meets it: a router test that sends each route signed out and signed
   in without the permission.

[examples/auction-room](../../examples/auction-room) refuses each way: its `Identify` sends someone
signed out to sign in, answers `Refused::unavailable` when its SQLite store cannot answer, and
refuses with `Refused::forbidden` a signed-in bidder at the house's desk and the house where buyers
bid (each area's caller type); its bid limit, the buyers' area's middleware, reads the same
`Caller` and refuses with `Refused::too_many`, as its sign-in limit does for an address with many
refused sign-ins.

A page and the form that posts back to it share one URL (`get = show, post = save`), and each
method names its handler, so who may read and who may write are each handler's arguments:
`show` takes `Option<Caller<Viewer>>`, `save` takes `Caller<Viewer>`.

## Areas

A part of the app with something of its own (an admin area, an account, seller tools) is an
area: its routes under one prefix, a stylesheet only its pages load
([styles](styles.md#areas)) if it needs one, and the caller every route there needs. Its routes
are a module of their own, `#[corten::routes(area = Admin)]`, where `Admin` is the route at
the prefix, mounted with the module's `area` function (`area(area, state)` with
`state = Db`). `caller = Staff` holds every handler in the module to taking
`Caller<Staff>`:

```rust
use corten::{http::request::Parts, prelude::*};

/// Someone on the staff: anyone else is refused (403).
#[derive(Clone, Hash)]
struct Staff;

impl<S: Sync> Identify<S> for Staff {
    async fn identify(_parts: &Parts, _state: &S) -> Result<Self, Refused> {
        // A real app reads the session and checks the role.
        Err(Refused::forbidden())
    }
}

#[corten::routes(area = Admin, caller = Staff)]
mod admin {
    #[route("/admin", get = dashboard)]
    pub struct Admin;

    #[route("/admin/users/{id}", get = user)]
    pub struct User<'a> { pub id: &'a str }
}

async fn dashboard(req: Req, _: Caller<Staff>) -> HtmlResult {
    req.page(html! { <Layout req={&req} title="Admin"><h1>"Admin"</h1></Layout> })
}

async fn user(req: Req, _: Caller<Staff>, Params(user): Params<admin::User<'_>>) -> HtmlResult {
    req.page(html! { <Layout req={&req} title="User"><h1>{user.id}</h1></Layout> })
}

#[component]
fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! { <html lang={req.lang()}><head><title>{title}</title><Corten /></head><body><main>{children}</main></body></html> }
}

fn app(pages: Routes) -> App {
    App::new(pages).area(admin::area)
}
# let _ = app(Routes::new()).router();
```

1. A route added to the module later without `Caller<Staff>` does not compile, and the error
   is at the handler's name in `#[route(..)]`. A handler cannot forget who may use it.
2. A route without a handler, two routes with one path, and a route outside the prefix
   (`/admn/users` in the `/admin` area) do not compile, so a link from an area's page cannot
   reach a route nobody serves. Neither does a prefix that is not a plain path (`/admin/{id}`).
   An area with no page at its prefix (`/docs/{page}` and nothing at `/docs`) gives the prefix
   route no handler, `#[route("/docs")] pub struct Docs;`: it is then only the prefix (a
   `corten::Prefix`), not a link, so `Docs.href()` does not compile and the app's 404 answers
   `/docs`.
3. Who passes is the app's model: `Staff::identify` reads the session and refuses with
   `Refused::sign_in` (no one signed in) or `Refused::forbidden` (not staff). Stricter parts
   are stricter types: `caller = Billing` on a `/admin/billing` area of its own.
4. A route in an area that another caller may use (an order's review form under
   `/account/purchases`, which needs another permission than the orders do) is in a module of
   its own in the same area, with that caller: `#[corten::routes(area = super::orders::Purchases,
   caller = Reviewer)]`. The app passes both modules to one area,
   `.area(|area| reviews::area(orders::area(area)))`, and each module's handlers are held to its
   caller. The area's stylesheet, deadline and prefix check apply to both. A module may hold a
   single route. The checks across modules are the app's at build rather than the module's:
   a route outside the prefix is a compile error at the `.area(..)` call, and two modules
   serving one path and method, or the same area given in two `.area(..)` calls, stop the app
   at startup.
5. An area a library ships is a function the app passes on,
   `.area(shop_admin::area)`. `Area::route::<R>(get(h))` adds a route by hand; Corten's `get`
   checks the handler as a routes module does, and `R`'s path must have the shape
   `#[derive(Route)]` writes (plain text, and parameters that are whole segments or followed by
   text in theirs, `/feeds/{name}.atom`), or the app does not compile.
6. Areas nest (`/admin` and `/admin/billing`, each with its own routes and stylesheet).

How the common cases look:

| The app | How |
|---|---|
| A signed-in area (account, dashboard) | `#[corten::routes(area = Account, caller = Viewer)]`, whose `identify` sends anyone else to sign in |
| A role's area, stricter inside | an area with `caller = Staff` and one on `/admin/billing` with `caller = Billing` |
| A page in an area that another permission opens (`/account/purchases/{id}/review`) | a second module in the area with its own caller, `.area(\|area\| reviews::area(orders::area(area)))` |
| Anyone reads, signed-in users write (reviews, a price alert posted back to its page) | the `get` handler takes `Option<Caller<Viewer>>`, the `post` handler `Caller<Viewer>` |
| Private everywhere (an internal tool) | `caller = Staff` on the app's routes module, and the sign-in route (and any webhook) in a module without it |
| An API only some callers may use | handlers that take `Caller<Partner>` and return `JsonResult<T>` |
| Only the author edits, members see their organization's records | the handler, which loads the record |
| A payment provider's scripts and frames, or style attributes in rich text, on some pages | an area with `.policy(..)` ([below](#a-policy-for-part-of-the-app)) |

### A policy for part of the app

What only some pages need is allowed on those pages only: an area adds to the app's policy for
the pages at its prefix and under it. A payment page that embeds a provider's fields, for example,
or the pages that show rich text with `style` attributes written in it (a size drawn from data needs
no policy: it is a [custom property](styles.md#values-from-data)):

```rust,ignore
App::new(url::router())
    .area(|area| payments::url::area(area).policy(|p| {
        p.script_src("https://js.stripe.com").frame_src("https://js.stripe.com").connect_src("https://api.stripe.com")
    }))
    .area(|area| help::url::area(area).policy(|p| p.allow_style_attributes()))
```

An area only adds (the closure gets `Sources`, which has no way to remove one), so no page allows
less than the app; nested areas add up, outermost first. The referrer policy below is the one
setting that goes the other way: an area can only make it send less. Each area's header is built once at
startup, and a request looks up its area by path only when some area sets a policy. A document
keeps the policy it loaded with, so a client navigation into or out of such an area loads the page
in full (the page's shell key includes the area's policy); a patch is applied under the policy of
the page it lands on. A `data-patch` form on a page in such an area whose route, elsewhere,
answers with a whole page (not a patch) gets that page under the other policy, so the runtime
loads the current page again rather than swap it in: answer such a form with a patch or a redirect.
An area that adds only sources the app already has keeps the app's policy and shell key. A policy for a single route is an area of one page. An `App::api` keeps its
own `default-src 'none'`.

Every page requires [Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)
(`require-trusted-types-for 'script'`), so the browser holds scripts to [Rule 1](../design.md#rule-html-macro):
markup reaches the page from a string (`innerHTML`, `insertAdjacentHTML`, `DOMParser`, the
runtime's `patch`) only through a policy, and the only one a page may make is the runtime's
(`trusted-types corten`), which takes nothing but the server's answers to the runtime's own
requests, from the page's own origin: a `data-patch` form, `ReadAgain` or `<corten-live>` a
script points at another origin gets nothing drawn, nor does a `Response` a script made (it has no
URL) or an event it dispatched. That catches a script's mistake; it is not a guard against a script
that sets out to forge what the runtime reads (a replaced `fetch` or `EventSource`, a `Response`
given a URL), which can feed any policy on the page. A script that builds markup from a string, the app's or one an area allows, gets a
`TypeError`. A third-party script that makes a policy of its own (a payment SDK, a sanitizer)
needs its name allowed, on its area's pages: `p.trusted_types_policy("payments-sdk")`, with the
name its provider documents (or the one its console error names). A script loaded from another
host needs no policy of its own: on a page whose `script_src` names one, a script sets a
`<script>`'s `src` the usual way (`script.src = "https://js.stripe.com/.."`), and so do the scripts
it loads (an SDK loading its parts), through a `default` policy `<Corten />` makes there, in an
inline script allowed by its hash, before any script after it runs. Set a `src` from a script
after `<Corten />` (a handler module, or a `<script src>` in the body); a `<script src>` tag
written in the markup needs no policy wherever it stands, but one that runs before `<Corten />`
and sets a `src` itself gets a `TypeError`, and one there that makes `default` itself takes the
policy's place (the console says so). That policy passes an http or https URL on
another origin, which `script-src` then holds to the sources listed (so a broad one,
`https://*.example.com`, lets in what it names), and nothing else: a URL on the page's own origin,
markup and script text from a string are still refused. A source that is a keyword or a scheme
alone (`'wasm-unsafe-eval'`, `https:`) names no host and makes no policy, and neither does a page
whose `script_src` has `'strict-dynamic'`, under which the browser ignores the hosts listed. One that writes strings with no policy runs once the app's own script
creates a `default` policy for it (`trustedTypes.createPolicy("default", ..)`, which then sees
every such string on the page and decides what passes) and the area allows
`trusted_types_policy("default")`; `<Corten />` then makes none, so the app's passes script URLs
too. A name is letters, digits and `-#=_/@.%`, and not `corten`;
like a source, it gives the area's pages their own shell key. The service worker is served under
the pages' policy too, and loads `Pwa::import_script`s through a policy of its own, under the
policy of its path, `/service-worker.js` (the app's, unless an area is mounted at `/`). A script it imports that calls `importScripts` itself (a library
that loads its parts) is refused: list each part as an `import_script`, or have the first one
create a `default` policy and allow `"default"`.

A form's handler that redirects to another origin (a hosted checkout, a sibling app, a return
address the app does not serve) needs that origin in `form-action`: Chromium and WebKit hold the
redirects a submission follows to the form's page's policy, and stop one it does not allow there,
on the form's page, with only a console error. A test that runs the request in process sees the
303 either way, so a debug build checks for the browser. It answers as a 500 that names the
origin and `Policy::form_action` (the error page's detail in every debug build, and logged; outside
`corten dev` it is printed to stderr too):

1. a `POST` whose body a form can send (none, `application/x-www-form-urlencoded`,
   `multipart/form-data` or `text/plain`), plain or `data-patch` (the same form without
   JavaScript is stopped),
2. from one of the app's pages: `Sec-Fetch-Site: same-origin` with an `Origin`, an `Origin` on
   the request's host, or neither header, as a test or a client that is not a browser sends,
3. whose redirect (any a handler answers: `req.redirect`, a `Location` set by hand, a sign-in
   redirect, or a `data-patch` answer's `corten-location`) goes to an origin that is not the
   page's own (its `Origin`, else its host; for a request that names neither, the app's
   `Policy::host` names) and that the page's `form-action` does not allow.

The page is the one the `Referer` names, so a test that sends it is held to that page's policy.
Without one, or with a `Referer` of `/` (what every page sends under a referrer policy that
sends only the origin, one a page sets itself included), it may be any of the app's pages, and
the redirect passes if any of the app's policies allows it.

Not checked: another method (no form sends it), a script's own `fetch` (held to `connect-src`),
a post from another site's page, a browser's post that does not say its page's origin
(`Origin: null`), a `Relay` answer, an app under `Policy::report_only` (the browser reports the
redirect and follows it), and a release build, which sends the redirect as written and does no
work for the check. The browser holds every redirect the submission follows to the form's
page's `form-action`, not only the write's own: a write that redirects to `/`, where a
signed-out `Caller` is sent to sign in on another origin, is stopped too. A later redirect
answers a `GET` the server cannot tell from a link, so it is not checked; allow those origins
as well. A form on a relayed page posting to one of the app's routes is held to the app's policy
at the page's path, not to the CSP the relayed page came with, which the app does not see: allow
the origin there too, or relay the write.

Every page is sent with `Cross-Origin-Opener-Policy: same-origin`, so a window another site
opened, or one this page opens on another site, cannot reach it. Two things loosen it, for the
whole app on `Policy` or, better, for the pages that need it on their area's `Sources`:
`allow_popups()` (`same-origin-allow-popups`: a popup this page opens keeps `window.opener`, for a
sign-in or payment flow that reports back from it) and `allow_cross_origin_opener()`
(`unsafe-none`, the browser's default, for an embed whose sign-in popup on the provider's origin
talks back to the page, such as Stripe's Connect embedded components, which both stricter values
break). `unsafe-none` gives up the page's isolation from other sites' windows (one that opened
it can navigate it and see when it closes, which cross-site leak attacks use), so keep it to the
pages that embed such a thing. An area only loosens it, and like a CSP source it gives its pages
their own shell key:

```rust,ignore
// With the script, frame, connect and image sources the provider's guide lists for its embed.
.area(|area| settings::url::area(area).policy(|p| p.script_src("https://connect-js.stripe.com").allow_cross_origin_opener()))
```

Every answer is sent with `Referrer-Policy: strict-origin-when-cross-origin`: other sites get the
origin only. A page whose address carries a secret (an OAuth consent's `?token=`, a password reset,
an invitation, a magic link) should not send it even to the app's own logs with the stylesheet and
font requests it makes, so its area makes the policy stricter with `referrer(Referrer::StrictOrigin)`
(the origin only, to everyone), `Referrer::SameOrigin` (nothing to other sites) or
`Referrer::NoReferrer` (nothing at all); `Policy::referrer` does it for the whole app. There is no
looser value, so nothing sends more than the default; nested areas, the app and the area each send
the least any of them allows, and like a CSP source a changed policy gives the area's pages their
own shell key. An `App::api` under the area sends the area's policy too. An answer that brings a
policy of its own (a relayed service's redirect, a handler's response) sends the least of its and
the area's, read as the browser reads it (every line, the last token it knows): `no-referrer` is
kept, `origin` becomes `strict-origin`, and `unsafe-url` gives the area's. A `<meta name="referrer">`
in the page applies only from where the parser reaches it, after the layout's own requests, so use
the area:

```rust,ignore
use corten::security::Referrer;
.area(|area| consent::url::area(area).policy(|p| p.referrer(Referrer::NoReferrer)))
```

Every full document (a first load, a reload, the page a write redirects to, an error page) is sent
with a `Permissions-Policy` that denies the powerful features no page uses unless the app says so:
the camera, the microphone, the screen's recording, the user's location, the motion sensors,
installed fonts, idle detection, window placement, payment and devices (USB, serial, HID,
Bluetooth, MIDI). A script the policy allows (an analytics tag, a payment SDK) then cannot ask the
user for one under the app's name, or read the motion sensors, which ask no one, and no frame in
the page can be given one. A page that uses one allows it, for its area or the whole app
(`Policy::allow_feature`), and is then back to the browser's default for it: this origin, and a
frame the app's markup gives it with `allow`. A payment provider's button that runs the Payment
Request API in its frame needs `Feature::Payment` on the checkout's area and `allow="payment"` on
its `<iframe>` (or what its guide lists):

```rust,ignore
use corten::security::Feature;
.area(|area| checkout::url::area(area).policy(|p| p.allow_feature(Feature::Payment)))
.area(|area| stores::url::area(area).policy(|p| p.allow_feature(Feature::Geolocation)))
```

Like a source, a feature an area allows gives its pages their own shell key. Chromium on Linux,
which has no Web Bluetooth, logs one console warning a page load, "Unrecognized feature:
'bluetooth'", and applies the rest; it is kept for the systems that have it. Only Chromium-based
browsers read the header today; in Firefox and WebKit (Safari) these features are the browser's
to grant, as before. Only a document is sent it, an HTML or XML answer (XHTML, SVG, `text/xml`, any `+xml`
type, which may run an XHTML `<script>`; Chromium shows a feed as text) other than one the runtime draws into the page it has: a
page, an error page, an HTML file the app serves. A navigation's or a patch's page (`corten-page`,
`corten-patch`), JSON, scripts and stylesheets are not, since the browser reads it only from the
document it loads (16 features: 250 bytes with the header's name, on HTTP/1.1, before any header
compression). It is decided by the answer and the request's mode together, so an HTML file a navigation fetched,
which the browser may later load from its cache as the page, has it, and so does a `corten-page`
or `corten-patch` answer that a browser's own request got. A relayed page keeps the one
its upstream sent, as it keeps its CSP; one that brought none gets Corten's. A line the app's
middleware or a handler sets goes after Corten's, and the browser reads the lines as one list in which a
feature's last entry counts, so the middleware denies more than `Feature` names
(`fullscreen=()`); one that names a feature Corten denies (`camera=(self)`) allows it there, so
allow a feature with `allow_feature` instead. A line must be valid structured-field syntax
(`feature=()` or `feature=(self "https://a.example")`): Chromium drops the whole header when one
line does not parse (the old `Feature-Policy` form `fullscreen 'none'`, say), every denial with
it, and logs "Parse of permissions policy failed".

An app upgrading to this default that embeds a provider's frame or script using one of these (a
wallet button's Payment Request, a map's location, a support widget's camera) loses it in Chromium,
with a console error naming the feature, until its area allows it. `report_only` does not cover the
header: Chromium's `Permissions-Policy-Report-Only` logs nothing to the console (Chromium 156)
and reports only to a reporting endpoint, which `Policy::report_to` (below) does not name for it,
so try the change on a staging copy in Chromium and look for that error.

### Reports of what a policy blocks

`Policy::report_to(&url::CspReports)` gives the browser somewhere to send a report of each thing a
page's CSP blocks, or under `report_only` would block: a third-party script writing markup from
a string (which Trusted Types refuses), a fetch to an origin `connect_src` does not list, an
inline script without the nonce. Without it a blocked script is seen only in the visitor's console,
so an app learns of it from a user, and a policy tried with `report_only` on a live site tells the
app nothing. With it, every page's CSP, its areas' too, ends `report-to csp`, and a full document
is sent `Reporting-Endpoints: csp="/csp-reports"` (a navigation's and a patch's answers are not:
the page keeps the endpoints it loaded with). The route is the app's own, and its handler takes
`security::Violations` (feature `json`):

```rust,ignore
use corten::security::{Policy, Violations};

#[route("/csp-reports", post = csp_reports)]
pub struct CspReports;

async fn csp_reports(Violations(found): Violations) -> StatusCode {
    // A few lines a post: one post may hold 100, and anyone can send them.
    for v in found.iter().take(4) {
        // The page without its query, which may hold a secret (a reset token).
        let page = v.document_url.split(['?', '#']).next();
        let (directive, blocked) = (&v.directive, &v.blocked_url);
        tracing::warn!(?directive, ?blocked, ?page, report_only = v.report_only, "a policy blocked something");
    }
    // 202 when the body held only reports of other types: still a success, so it is not sent again.
    if found.is_empty() { StatusCode::ACCEPTED } else { StatusCode::NO_CONTENT }
}

App::new(url::router()).policy(Policy::new().report_to(&url::CspReports))
```

Browsers do not send one shape: Firefox (157) posts a batch in the Reporting API's format
(`application/reports+json`, a list), about a minute after the first violation, and WebKit (27.2)
posts each report as it happens, alone, as `application/csp-report`; an app that read the body
as `Json<Vec<_>>` would answer every one of Safari's 415 and never see it. `Violations` reads
both, leaves out reports of other types, and gives each violation's page, directive, what was
blocked, whether the policy only reported it, the script, line and column when the browser says,
and the start of what was blocked (`sample`, which may hold the visitor's data). A list gives
at most its first 100 violations. A body of another type is answered 415, one that does not read
400, and one whose length is over 256 KiB 413. The page's URL (`document_url`) keeps its query,
which on a password reset or an invitation holds a secret, so a log that is kept should drop it.
Chromium (156,
Playwright's build) queued its reports for a local endpoint (`http://localhost`, and `https`
with a certificate it was told to accept) and sent none in testing, so the smoke checks delivery
in Firefox and WebKit. Anyone can post to the route, so a report is a hint,
not a fact: log it as debug text (`?field`, which escapes a line break), count it, and never
put its URLs in a page unescaped or trust them. One post can hold 100 violations, so a busy app
counts them, or puts the route under a rate limit, rather than log each. The route must have a
`post` handler, in a module that requires no caller (a browser posts a report without the
visitor's session): any other route passed to `report_to` does not compile. What is not seen
at compile time is a handler that takes a `Caller` itself, or middleware that refuses a request
without a session: either compiles, and every report is refused, so the handler takes no
`Caller` and the route sits outside such middleware. A collector
elsewhere is an `https://` URL instead (`Policy::report_to(&Uri::from_static("https://csp.example.com/r"))`),
which must accept a cross-origin post of either type, and answer the CORS preflight that
`application/reports+json` brings. Browsers send reports only to a secure origin,
`https:` or `localhost`, from a page whose own origin is secure; startup panics on an `http:`
URL to another host, which a browser would drop without a word. `card-market` logs its reports,
and its smoke checks that Firefox and WebKit deliver one, and that it is read, for a script that
writes markup from a string.

The old `report-uri` directive is not written: the current release of each engine reads
`report-to` (Firefox and WebKit were seen sending to it), and a browser that reads `report-to`
ignores `report-uri`, so an older release still in use (an older Safari or Firefox) sends
nothing. `Violations` still reads that older shape (`{"csp-report": {..}}`), which a collector
may forward. The endpoint is named
for the CSP only; `Permissions-Policy` violations are not reported to it. A trial of one
directive (the enforced policy plus a report-only one carrying the change) is not built in:
reports from the enforced policy already show what a change would have to allow, and
`report_only` tries the whole policy on a staging copy or a live site.

## Error pages

Every way a request can fail is a `Failure`, given to the app's error page for a browser
(`App::error_page`), sent with `failure.status()` and `X-Robots-Tag: noindex`:

| `Failure` | When | Status |
|---|---|---|
| `NotFound` | no route has the URL, or the handler returned a 404 | 404 |
| `WrongMethod` | the route has the URL but not the method (`Allow` is kept) | 405 |
| `CrossSite` | a write another site sent, refused before anything else ran | 403 |
| `Refused { status }` | a `Caller` refused, with nowhere to sign in | 401, 403, 429 |
| `Unidentified { detail }` | who is asking could not be looked up (`Refused::unavailable`), unlike a handler's own 503 | 503 |
| `Rejected { status, detail }` | the path, the query or the body did not parse | 400, 415, 422 |
| `Failed { status, detail }` | the handler returned an `Error`, or the deadline passed while it waited for the client to send the body | 500, or its status; 408 for the body |
| `Panicked { detail }` | the handler panicked | 500 |
| `TimedOut` | the handler ran past its deadline (`App::deadline`, or its area's or API's), not waiting for the body | 503 |
| `Offline` | the PWA's offline page | 200, so the worker keeps it |

Without `App::error_page`, a browser's failure is Corten's plain document: no stylesheet of the app's, no
navigation. That is right for an API or a first sketch; an app with a layout sets one so a failure
is drawn in it. In a debug build (`corten dev`, a router test), an app that has a stylesheet (its
components', an area's, or a `.css` file among its static files) and no error page is told so once,
at startup.

The error page keeps the headers the failed response had (a request id, `Retry-After`,
`WWW-Authenticate`, `Server-Timing`, `Allow`), so what a handler or a middleware said about a
failure still reaches the client. The ones that described the old body (`Content-*`, `ETag`,
`Last-Modified`) and `Cache-Control` are the error page's own, and a header the error page sets
wins, except a `Cache-Control` that names `no-store` (`NoStore`, `no_store` on its route, or one written by hand, on any
of its lines and however a cache could find it): the failure said nothing may keep it, so the
error page goes out `no-store`.

The error page is an async function of the `Failure` and then extractors, as a handler's
arguments are, with the state they read given beside it (`()` for none). A layout that shows
who is asking takes the caller as a page does, so a signed-in user who mistypes a URL or is
refused still sees themselves signed in, in their theme:

```rust,ignore
async fn error_page(failure: Failure, req: Req, viewer: Option<Caller<Viewer>>) -> HtmlResult {
    req.page(html! { <Layout req={&req} viewer={viewer.as_deref()} title="Not found">..</Layout> })
}
// App::new(url::router()).error_page(error_page, store.clone())
```

Its extractors see the request's URL, `Cookie`, `Authorization`, `Accept-Language` and mode,
not its body (a body extractor does not compile). The caller is looked up only when the error
page takes one and only for a failure: an unknown URL looks it up once, and a handler that read
it and then failed (refused, say) gives the error page the caller it found, with no second
lookup: the page shows who the handler saw (a sign-out that removed the session and then failed
still shows them signed in), and a lookup that failed because the store was down is not tried
again. A middleware's own request extensions do not reach it: the handler took that request,
and keeping them for a failure would copy every request's. Who is asking is a `Caller`, and a
trace span goes in `App::layer`, around the error page too. A request id a middleware makes can
go on the answer as a header (which the error page keeps), but the page's body cannot show it.
When the lookup itself fails, an optional caller is `None` there, so the page is drawn signed
out rather than not at all. Keeping the credentials for it is measured below.

`failure.detail()` is what went wrong, under `corten dev` only; in production it is logged. A
debug build's error about the app's own code (a component it does not serve, a `Refresh`
header, a write redirected outside `form-action`) is the exception: it is set in every debug
build, so a router test's error page names it.
The error page `corten new` writes names every case without `_`, so when Corten adds one the
app stops compiling instead of showing the wrong text. A JSON route's failures, a data
client's and every failure under `App::api` are a JSON Problem Details document instead
(`application/problem+json`, `{"title","status","detail"}`).

When the error page came to take extractors (callgrind, release build, in-process `oneshot`,
the difference between 1,200 and 200 requests over 1,000, three runs each, a minimal app with
the default error page):

| Request | Before | After |
|---|---|---|
| a small page, full document | 21,100 (20,836-21,155) | 21,201 (21,150-21,203) |
| the same page with a cookie | 21,639 (21,601-21,654) | 22,030 (21,713-22,087) |
| a page whose handler reads who is asking | 24,969 (24,955-24,992) | 25,369 (25,346-25,395) |
| unknown URL, HTML 404 page | 20,650 (20,650-20,716) | 26,122 (26,097-26,150) |

A page keeps the request's credentials for the error page (two header lookups and a reference
count each); a failure rebuilds the request for the error page's extractors and runs them.

The cost of a request through all of this is measured in [the request path](#the-request-path).
