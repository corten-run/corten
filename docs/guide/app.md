# The app

[Back to the guides](../../README.md#documentation)

`corten::serve(App::new(url::router())).await` puts everything a production app needs around
your routes. Each default can be replaced in one line. An app with live streams also needs
an HTTP/2 proxy or CDN in front ([Deploying](deploy.md)); ending TLS in `serve_wrapped` does
not remove that requirement.

| Concern | Default | Override |
|---|---|---|
| Address | `HOST` (both loopback addresses, `127.0.0.1` and `[::1]`, so `localhost` answers at once however it resolves), `PORT` (`3000`) | environment; `corten::serve_on(listeners, app)` for listeners of your own (a Unix socket) with the same shutdown, `corten::serve_wrapped(listeners, move \|tcp\| acceptor.accept(tcp), app)` for HTTPS ([below](#your-own-listeners)) |
| Names it answers to | `localhost`, names under it and IP addresses; any other requested name gets `421`; a missing HTTP/1.1 `Host`, or a repeated or malformed `Host`, gets `400` ([below](#host-names)) | `HOSTS=shop.example,.shop.example` in the environment, or `Policy::host("shop.example")` |
| The document | none: each page brings its own, the app's layout component with the page in it (`req.page(html! { <Layout ..>..</Layout> })`); `corten new` writes the layout | the layout is the app's code ([views](views.md#the-document)) |
| Routes | a `#[corten::routes]` module: each route names its handlers, and `router()` is what `App::new` takes; every handler is checked when the crate compiles, there and in `Area::route` and `Api::route` (Corten's `get`, `post`, ...), so no route reaches the app unchecked | |
| What handlers share | nothing | `#[corten::routes(state = Shared)]` and `router(shared)`; on `Shared`, `#[derive(Clone, FromRef)]`: `Clone` lets each route have a copy and a handler take the whole state, and `FromRef` lets a handler take one part, `State<Market>` (each field's type once; `#[from_ref(skip)]` leaves a field out; [design Choice 33](../design.md#choice-state-derives)) |
| What a route answers | its handler's return type: `HtmlResult` (a page, a patch, a redirect; failures are the error page) or `JsonResult<T>` (failures are JSON too; `Result<JsonResponse, JsonError>` for a status or cookie of the handler's own, or another server's answer passed on) | `Public<..>` around either for an answer that is the same for everyone, `NoStore<..>` (or `no_store` on the route) for one nothing may keep ([below](#caching)); `HtmlResult<Patches>` for a handler that answers only patches (`req.patch_or`, `action.patch`, `req.invalid`): the `get` of a route that says `patches`, one a part of a page is read again from ([Requests and forms](requests-and-forms.md#a-read-that-has-not-caught-up-yet)), and a typed write route, which skips its copy of the request head. Middleware taking `Req` before the route and raw `Table` handlers taking `Req` can still copy it ([layout reads](views.md#the-document)) |
| The client's address | the connection's peer; no `X-Forwarded-For` is read | a handler takes `ClientIp`; behind a proxy, `PROXIES=10.0.0.0/8` in the environment or `Policy::proxy("10.0.0.0/8")` ([below](#the-clients-address)) |
| Who is asking | nothing: no lookup runs | a handler takes `Caller<Viewer>` (`Viewer: Identify`), looked up only then, once per request ([below](#who-is-asking)) |
| A part of the app | none | `.area(admin::area)` for a `#[corten::routes(area = Admin)]` module: its routes under the prefix (a route outside it does not compile), with `.components(&[..])` for a stylesheet only its pages load and `caller = Staff` for who may use it ([below](#areas)) |
| Error pages | every [`Failure`](#error-pages) in a plain document, in the request's mode (page, swap or JSON), sent with `X-Robots-Tag: noindex`; the error is logged, and shown only under `corten dev`; right for an API or a first sketch; an app with a layout sets one, and a debug build warns once at startup when an app with a stylesheet has none | `.error_page(page, state)`: `async fn(Failure, Req, ..extractors) -> HtmlResult`, in the app's layout and for who is asking; `corten new` writes one that names each case |
| JSON-only routes | none | `.api(api::api)` for a `#[corten::routes(api = ApiRoot)]` module: every failure under the prefix is JSON, unknown URLs included, with no document ([below](#json-only-routes)) |
| WebSockets and relays | none | a handler takes `Upgrade` and returns its `websocket(..)` or `switch(..)`; `Relay` passes another server's answer on as it came ([below](#websockets-and-relays)) |
| Security | a CSP that allows Corten's inline tag (the import map) by hash (a nonce only when the layout or a handler asks for one) and requires Trusted Types, with only the runtime's policy, so no script writes markup from a string, a `Permissions-Policy` on each full document that denies 16 powerful features (camera, microphone, screen recording, location, motion sensors, installed fonts, idle detection, window placement, payment, and devices: USB, serial, HID, Bluetooth, MIDI), nosniff, referrer, frame and opener headers, a same-origin check on unsafe methods; forms go to this origin only | `.policy(Policy::new()...)`: another origin for scripts, styles, images, `fetch`, frames, fonts, or `.form_action("https://pay.example")` for a form (or a form's redirect) that hands the user to another site, `.trusted_types_policy(name)` for a third-party script's own Trusted Types policy, `.allow_feature(Feature::Geolocation)` for a feature the app uses, `.frame_ancestors("https://partner.example")` for a site that may show the pages in a frame; one part of the app's pages only: `Area::policy` ([below](#a-policy-for-part-of-the-app)) |
| Caching | static files and the runtime cached forever; everything rendered `private, no-cache` ([below](#caching)) | return `Public<HtmlResult>` (or `Public<JsonResult<T>>`) for an answer that is the same for everyone |
| Static files | component scripts and the components' stylesheets (one file, plus one per area that lists components and one per set of areas that list the same components) at content-hashed, immutable URLs; each script loaded by the pages whose handlers use it | `.assets(Static)`: `static/`, compiled into the program by `corten::assets::embed!` (a constant per file, `req.asset(Static::STYLE_CSS)`) and served the same way ([below](#static-files)); `/favicon.ico` answers the directory's `favicon.ico`, else its `favicon.svg`, cached a day, unless a route of the app's matches the path; `.components(&[..])`, `Area::components(&[..])` ([styles](styles.md#areas)) |
| Middleware of your own | none | `.middleware((RequestId, RateLimit))`: steps of the app's own, at one place in Corten's order; `Area::middleware`, `Api::middleware` for the requests at a prefix ([below](#your-own-middleware)) |
| Health | `/health/live`, `/health/ready` (always ready; a check that has not answered in 800 ms is `unavailable`, [below](#health)) | `.ready(\|\| async { db_ok().await })`, `.ready_within(Duration::from_millis(500))` |
| Work that lives as long as the app | none | `.task("refresh", refresh)`: started by `serve`, told when shutdown begins ([below](#tasks)); on a schedule, with tokio's intervals ([below](#on-a-schedule)) |
| Connections | a request's head (its line and headers) must arrive within 30 seconds of the connection opening or its last answer, or the connection is closed; it may be 32 KiB, with up to 100 headers, or it is answered 431 and the connection closed; a write that waits 60 seconds for room in the send buffer closes its connection; no limit on how many are open | `.header_timeout(d)` (`None` behind a proxy that buffers heads), `.max_request_head(bytes)`, `.send_timeout(d)` (`None` behind a proxy that reads answers as they come), `.max_connections(n)`: past it, connections wait to be accepted, up to 511 in each listener's queue on Linux, and a WebSocket or tunnel counts until its route closes it; `.own_http1(true)`: requests without a body are read and answered by Corten's own connection code in the place of hyper's, with every limit here held the same ([below](#cortens-own-connection)); connections are HTTP/1.1, so an app with live streams goes behind a proxy or CDN that serves HTTP/2 or HTTP/3 ([Deploying](deploy.md)) |
| Deadline | a handler that has not started its answer in 30 seconds is answered 503 (`Failure::TimedOut`), or, under `serve`, the client's 408 when it was waiting for the body (`Failure::Failed`) | `.deadline(d)` (`None` for none); `Area::deadline`, `Api::deadline` for slower routes at a prefix |
| Request bodies | `Json`, `Form`, `String` and `Bytes` read at most 2 MiB, and an `Upload` keeps as much unless its handler sets `upload.limit(bytes)`; over it, a 413 | `.body_limit(bytes)`; `Area::body_limit`, `Api::body_limit` (the innermost prefix that sets one decides); a proxy in front sizes its own body limit from it (nginx's `client_max_body_size`, [Deploying](deploy.md)) |
| Shutdown | Ctrl-C and `SIGTERM` (on Windows Ctrl-C, Ctrl-Break, the console closing and system shutdown), or the app's `corten::shutdown()`, tell the tasks, end live streams, close the listeners, let requests in progress finish and answers be written for the longer of the grace and the request's deadline (its area's or API's where that sets one; a connection still open then is closed), and wait for the tasks and for work handlers finish (`Signal::finish`) (5 seconds) | `.shutdown_grace(d)`; the platform's wait before it kills the process (`docker stop`: 10 seconds; Kubernetes: 30) above the longer of the grace and the deadline of every route whose requests should finish |
| Logs | errors, warnings and other `tracing` events at `INFO` and above to stdout, one line each, as `tracing-subscriber`'s `fmt()` writes them without targets (`2026-11-06T21:20:29.018154Z  WARN corten: ...`), in its colors when stdout is a terminal and `NO_COLOR` is unset; control characters other than a tab are escaped in every field, so request text cannot start a line of its own or send the terminal a command; spans are not printed (feature `log`, a subscriber of Corten's own with no dependency) | set your own `tracing` subscriber first (`tracing_subscriber::fmt().init()` for spans, filters such as `RUST_LOG` or JSON lines); `serve` then leaves it alone |
| Access logs | off, also in the app `corten new` writes | `.access_log(true)`: one `INFO` event per response, target `corten::access`, after every stage and app layer, at a measured cost ([below](#access-logs)) |
| Compression | pages per request (zstd, brotli, gzip), static files once at the highest levels, JSON held as bytes (`json::Raw`) once when it is sent again, live streams per event with the compression context kept, so a redraw costs what changed, and a `Media::stream` download per chunk the same way (zstd, else gzip, never brotli, which Playwright's WebKit on Windows holds back; feature `compress`; the Dockerfile `corten new` writes links zstd to the build image's libzstd, `ZSTD_SYS_USE_PKG_CONFIG=1`, rather than compiling its C sources, which cut a clean release build's time by about a third, so the server needs `libzstd.so.1` in the image it runs in; a build elsewhere compiles zstd unless that variable is set where pkg-config finds libzstd); a `Relay`'s answer goes on as the upstream sent it | |
| Installable app | off | `.pwa(Pwa::new(manifest))`: manifest, generated service worker, offline page; `.network_only("/auth/")` for paths whose answers the worker never caches or replaces with the offline page (sign-in, checkout, an OAuth callback), where a GET navigation still reaches the server once: the worker answers it with the request navigation preload already sent, or leaves it to a browser without navigation preload ([design Choice 56](../design.md#choice-network-only-preload)) |
| A route outside all of the above | none: every route gets every default here | `unstaged` on one route's `#[route(..)]`: no same-origin check, middleware, security headers, cache rule, deadline or error page, for an answer the same for everyone who can reach it; the host check stays ([below](#a-route-outside-the-stages)) |
| Languages | none | `.messages::<Msg>()`: `req.t()` and `req.lang()` follow `Accept-Language`, or the locale a page's URL names (a `Locale<Msg>` route field the handler gives `req.set_locale`, [Views](views.md#a-locale-in-the-url)); each page says its locale in `Content-Language` |
| Visitors' time zones | not known: dates are UTC unless a zone is given | `.client_zone()`: the runtime keeps the browser's zone in a `corten-zone` cookie, `Option<ClientZone>` reads its name and, with the `zones` feature, `req.zone()` gives it with its rules; `.zoned_dates()` (`zones` feature) also writes dates in it ([Views](views.md)) |
| Dev mode | when `CORTEN_DEV` is set (`corten dev` sets it): errors shown on the page, open pages reload after a rebuild, and the browser's console names a form control drawn with a value its own attributes refuse (a stored `250` under `step="100"`), which stops its form being sent, and a live region drawn inside another (`errors.form_message()` inside the kit's destructive `Alert`), which a screen reader may announce twice, and a handler given a form field its form does not have as the handler takes it (`js::fill(f.weight)` where the form draws `weight` as a select, or no `weight`), with what the form has, which the runtime would refuse when the handler runs ([Scripts](scripts.md#form-fields)), and it warns of a closed `<dialog>` or popover that a rule inside `@media` or `@container` gives a `display` (a filters rail drawn in place from a breakpoint, or an open look written without `[open]`), which the components' stylesheet keeps hidden, with the rule for each, from `/corten/dev.js` and the modules it imports, `/corten/on.js` (the `data-on` parser) and `/corten/field.js` (the field lookup), which only a dev server serves | `.dev(bool)` |

`App::header_timeout` (30 seconds unless set) bounds what comes before a request: a client that
opens connections and sends its head slowly, or never finishes it, cannot hold them (an idle
keep-alive connection closes after it too). It counts from when an answer's last bytes have been
handed to the socket (the system may still hold some of them to send), not from when the server
took the answer's last part, so a long download its client reads steadily is not cut by it. A
connection that switches, with a `101` (a WebSocket) or a `2xx` to `CONNECT` (a tunnel), is the
route's from then on: the header timeout no longer applies and `App::send_timeout` bounds only
its writes that wait, so one on which neither side sends stays open until the route ends it, and
idle limits there are the route's
([design Limit 13](../design.md#limit-protocol-switch)). It counts against `App::max_connections`
while it is open, so a route that accepts them ends idle ones (closing one that has sent no frame
for a set time, and pinging one that only listens so its pongs count) and bounds how many it
keeps, or idle sockets take the cap from every other request. A refused `CONNECT` is an answer
like any other. A `2xx` to `CONNECT` goes out with no body, `Content-Length` or
`Transfer-Encoding`, whatever its route set, since RFC 9110 9.3.6 forbids them there. A clock of
the server's own checks the header timeout a few times a
second, so a connection closes within a tenth of the timeout of it (at most a second either way). It applies to `serve`, `serve_on` and `serve_wrapped` alike (where a TLS handshake's time counts toward it), on
every listener. `App::send_timeout` (60 seconds unless set, nginx's `send_timeout`) bounds what
comes after: a write that finds the connection's send buffer full may wait that long for room,
or the connection closes, so a client that sends requests and stops reading cannot hold its
connection, and a live stream, a feed or a WebSocket to one ends rather than waiting on it. With
`None`, such a client holds its connection until shutdown, whether its answer is a stream or a
whole body: the header timeout does not start until the answer has been sent. It
counts only while a write waits, from when the connection last reported room: a stream quiet
between events is not cut, and a download is cut only when its reader goes that long without the
system reporting room, which it does once a good part of the buffer is free, so a reader that
takes a little each minute can be. Over TLS a write or a flush stays pending while the TLS library
sends what it holds to a client reading slower than the server writes, and its wait starts over at
each report of room too. How far apart the reports come depends on how the client takes bytes
from its socket: one that takes them in bursts (a TLS client that reads whole records,
`curl --limit-rate`) leaves longer gaps than one taking the same rate evenly, over TLS and plain
HTTP alike. Measured with 16 KiB buffers and a 2-second `send_timeout`, 5 tries each: a
tokio-rustls client taking 2 KiB every 125 ms was cut after 5 to 8.5 seconds, while the same rate
taken evenly from the socket was kept past 30 seconds over TLS and plain HTTP; a plain reader
taking 16 KiB once a second, and `curl --limit-rate 16K` over either, were cut. Keep the timeout
well above the gaps your slowest readers leave: with the 60-second default, a reader taking 2 KiB
every 4 seconds (512 bytes a second) evenly from its socket was kept past 300 seconds over plain
HTTP, and a tokio-rustls client at that rate, reading whole records, was cut after 123 (one try
each).
While the connection's task has spent tokio's cooperative budget (a route reading a flood of
input), a report of room does not start the wait over. A TLS connection's last record, written
as it closes, is held to it too. The same clock checks it; with both timeouts `None` (behind a
proxy) the clock and its work per request are gone. Once shutdown begins, a connection
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
(a WebSocket or a tunnel) is told and not waited for.
`App::max_request_head(bytes)` (32 KiB unless set) bounds how large the head may be, a URL
included: one past it is answered `431 Request Header Fields Too Large` as soon as it passes, by
the HTTP server, with no body and none of the app's headers, and the connection closes (a client
still sending the rest may see it reset instead). With the limit raised above 64 KiB, a URL over
64 KiB gets 414. A request has at most 100 headers whatever the size.
`App::max_connections(n)` caps how many connections are open across the listeners (none unless
set, [design Choice 19](../design.md#choice-head-size)). A switched connection, a WebSocket after
its `101` or a tunnel after a `2xx` to `CONNECT`, counts until its route drops the socket
([design Limit 13](../design.md#limit-protocol-switch)), so every connection the app accepted
counts until it closes. A relayed switch's connection to its upstream is not counted itself;
there is at most one per client connection, which is. Other connections the app opens itself (to
a database, an API) are not counted.
Together they bound what clients that never
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
flood's hold ended). An app with WebSockets or tunnels counts the ones it keeps open within the
same cap, each holding what its route keeps for it (a WebSocket library's read and write
buffers, which these floods did not measure), so it sizes the cap from that too, with room left
for the platform's health probes: they wait behind a full cap like any other connection, and a
platform restarts an app whose liveness probe keeps timing out. Past the cap,
connections wait in each listener's queue (up to 511 from `corten::listeners` on Linux). By how
Linux queues them (reasoned, not measured), the kernel keeps what each has sent so far, up to its
receive buffer, in the host's TCP memory, and charges it to the container when the app accepts
the connection, so it lands as the cap frees room. The Dockerfile `corten new` writes preloads jemalloc in the image's last
stage with that background thread and a 512 KiB thread cache, which keeps brotli's buffers between
responses for a page up to about 200 KB ([design Choice 23](../design.md#choice-jemalloc-image));
with it, on a quiet Linux host, the floods above left 9.3 to 10.3 MiB where glibc's allocator left
329 to 354 (card-market's image of `bcf4aa073`, three runs each, as are the figures that follow).
The cache holds what its threads used and an idle app does not give it back: on eight CPUs
card-market held 38 to 40 MiB at rest after brotli pages of 9.8 KB to 496 KB, and 40 to 54 after
bursts of 2,000 slow readers of those pages uncompressed, where it held 14 and 16 with a 64 KiB
cache (and 34 to 35 and 399 to 426 on glibc's allocator). So count 3 to 5 MiB a CPU for it in the
container's memory when responses run to hundreds of KB. jemalloc's own rule, up to 20 buffers of
each size a thread, allows 57 MiB a thread at the most; no run here came near that and none was
built to reach it. An image of the app's own adds
the same three lines, before any `USER` line; removing them runs the app on glibc's allocator:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:524288
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
`Upload`'s or a `pieces_up_to` limit, or over the limit of `Json`, `Form`, `String` or `Bytes` (`App::body_limit`, 2 MiB unless set),
is read past is the 413 that read gives. Only a request
`corten::serve` reads from its connection is marked as waiting for its body; through
`app.router()` served another way that deadline is the 503 (the 413 still holds). A connection
loop of the app's own gives each request its client's address as a `corten::PeerAddr` in the
request's extensions, which `ClientIp` starts from as it does from `serve`'s connection. See
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

The layout around `<main>` renders on full page loads and on a write's own page (a form drawn
again, [layout reads](views.md#the-document)); a client navigation gets the `<title>`, the page's
head tags and `<main>`'s children. Every page carries a key hashed from the
caller its handler read (if any), the deploy and the layout that rendered it (where its `html!`
document is written), and when a navigation or a form answer arrives with a different key
(sign-in, sign-out, a new release, a page in another layout), the runtime loads the whole
document, so the layout is never stale.

## Corten's own connection

`corten::serve` reads and writes HTTP/1.1 with hyper. `.own_http1(true)` has Corten's own
connection code answer the requests that have no body, and leaves the rest to hyper
([design Choice 78](../design.md#choice-own-http1)). It is off unless the app sets it.

```rust,ignore
let app = App::new(url::router()).own_http1(true);
```

A connection's requests are then read and answered by Corten up to the first one whose head has
a `Content-Length`, a `Transfer-Encoding`, an `Expect` or an `Upgrade` header (whatever the
header says), or that is a `CONNECT`, or an HTTP/1.0 request that asks to keep its connection.
The answers before that request are sent, and it and every request after it on the connection
are hyper's, as all are with the switch off. So a request's body is read by hyper either way, and
a WebSocket's handshake and a tunnel are hyper's too: a route sees the same `Upgrade` and the same
socket.

The app is given the same requests, and its clients are answered in correct HTTP with the head
hyper writes: the same lines in the same order. This is not a promise of hyper's bytes for every
answer. A test sends both connections the same streams of bytes, well formed and not, and
compares what comes back byte for byte, `Date` aside; what it sends and what it does not is in
the Choice. Every limit above holds as it
does with hyper: the header and send timeouts, the size of a head and its 100 headers, the cap on
connections, the deadline, and shutdown's grace. The host check answers these requests as it
answers any other ([below](#host-names)). What differs:

1. The answers to requests that arrived together (a pipeline) leave in one write, where hyper
   writes each as it is made. No answer waits for a request that has not come: what is written is
   sent before the connection waits for anything. For a handler this means it may run sooner
   than hyper would run it. hyper begins a request only when the answers before it have been
   taken by the socket, so for a client that sends requests and reads no answer it runs one
   handler beyond what the socket takes. Here handlers run for the requests a client has sent
   until 16 KiB of their answers are written and not taken, whatever the client reads. That
   bound is in bytes of answers, not in requests. The connection does stop after 16 requests
   to let other tasks run, but that holds the handlers to 16 only where all of them had been
   read already and none of their handlers waited: a handler that waits, as any that does work
   does, begins the count again. So how many run on one connection is 16 KiB over the length
   of an answer. Measured for a client that reads nothing: 24 handlers for an answer of 697
   bytes (two bytes of text with the headers an app sends unless it says otherwise; 23 where
   every feature of the crate is on, which makes that answer 720 bytes) where hyper ran 1, and
   213 and 219 for answers of 77 and 75 bytes, the shortest there are.
   So a handler can run for a request whose answer is never sent, where hyper would not have
   begun it: the client left or stopped reading, or the connection closed on an answer before
   its own. A handler that changes something has changed it then. Only a client that pipelines
   sends such requests, and HTTP promises it nothing about a request it got no answer to. An
   app whose handlers for requests without a body are costly, or change something, should
   leave the switch off or bound that work itself (for each client, or by how much runs at
   once), unless its clients reach it through a proxy that does not pipeline.
2. An answer's trailers are not sent, nor a `Trailer` line with them, and a status's reason
   phrase is always its own.
3. A head that reaches `max_request_head` unfinished and is malformed further on is refused by
   both, but may get 400 from one and 431 from the other, since the two read the socket in pieces
   of different sizes. For the same reason a head that is malformed on one line and has not ended
   may be refused at once by one and only at its end, or at the header timeout, by the other,
   when its bytes come in several pieces: each looks through an unfinished head again only when
   its last line may have come. A head that came at once is refused by both at once.
4. A body that fails. An answer whose body fails before any of the answer had to be sent is not
   sent at all, the answers before it are, and the connection is closed. With hyper that is a
   body that fails within its first 16 pieces or about 400 KB; here it is one that fails at
   once, behind pieces that fit a 16 KiB buffer, or behind one larger piece. A body that gives
   more than that without a wait and then fails has an answer cut short here (its head and some
   of its body, then a closed connection) where hyper would have sent none of it. A client takes
   neither for a whole answer.
5. A request whose body its handler did not read. hyper keeps such a connection only if one more
   read of the socket finishes the body, and otherwise closes it behind the answer. That is
   hyper's rule with the switch on or off, but where its reads end is not the same: with the
   switch on they are counted from the request with the body, the ones before it having been
   answered without hyper. So behind an unread body too long for hyper's next read to finish
   (16 KiB or more beyond what came with its head), a connection may be kept with the switch on
   where it would have been closed with it off, or closed where it would have been kept. Nothing
   is answered twice or out of order, and a client that sends its next request again on a new
   connection, as HTTP has it do when a connection is closed on it, sees no difference.
6. A client that pipelines requests and reads no answer holds a little more of the server's
   memory than with hyper: the same flood of such clients took a 4 GiB container to 2,178 to
   2,323 MiB with the switch on and 2,101 to 2,137 MiB with it off (measured at `568aa8d1a`,
   nine runs each). Most of either is socket buffers, and so is the difference: the server's
   own memory was lower with the switch on, and the kernel held more, the answers the
   connection had written, about twice as many by then, for clients that took none.
   `max_connections` bounds how many connections hold one, and `send_timeout` how long a
   connection that takes nothing is kept. This is why the switch is off unless set; behind a
   proxy that does not pipeline to the app it does not arise. And a connection that has been
   handed to hyper holds about 1.6 KiB more while it waits than one hyper served from the start
   (10,082 bytes against 8,470), so an app whose connections mostly carry bodies gains nothing
   in memory.
7. A body type of the app's own that panics. A panic where a body is asked for its next piece
   ends its answer as a failure does (item 4), with either connection. A body that panics where
   it is asked how long it is or whether it has ended (`size_hint` and `is_end_stream` of
   `http_body::Body`), or as it is dropped, ends its connection with either; with the switch on,
   the answers to the requests that arrived with its own and had not yet been sent are lost with
   it, where hyper had written each as it was made. Those two questions are answered by the
   app's code only for a body type the app wrote and gave to `Body::new`.
8. A client that closes its side of the connection before its answer is whole. Neither
   connection goes on answering such a client once it knows: the answers before the one being
   made are sent, for as long as `send_timeout` lets them wait, and that one is given up. Where
   the answer waited for anything (its handler, its body's next piece, the client to read) both
   cut it at the same byte in every sequence tested. Where nothing waited, a body of megabytes
   whose every piece was ready and a client that took every write, each learns of the end only
   when its task next yields, which the two do after different amounts, and may have finished
   the answer by then: of 41 MB in 20 KiB pieces a run read all from hyper and 2.6 MB from
   Corten's connection, and of 20 MB in 512-byte pieces 1.1 MB from hyper and 2.1 MB from
   Corten's.
9. A request without a body that Corten answers arrives with `Body::empty()`, where hyper gives
   the handler a body that has already ended. Both hold nothing and report that they have ended
   with length 0; only the body's `Debug` text differs for the handler.

What it saves, counted in instructions a request over a socket (release build, jemalloc, one
connection, at `568aa8d1a`): the shortest request the counting kit sends, to a route that says
`unstaged` and answers two bytes, goes from 10,587 to 9,335, a staged API route's `GET` from
18,354 to 17,096, and a 12 KB page from 33,220 to 32,186, each with three allocations fewer. A
request with the header lines a browser sends costs as many instructions as it did, to a
third of a percent either way (the same `GET` 23,894 and 23,811, a compressed page 211,835
and 211,950), with the three allocations fewer; a request with a body costs what it did. A
request whose head is longer than 2,560 bytes costs more than it did: one with a `Host` name
of 4,096 bytes goes from 22,503 to 24,313, since Corten's connection reads less at first than
hyper does and takes such a head in two reads. A
connection waiting for a request holds 7,424 bytes where hyper's holds 8,471. No time has been
measured yet, so this is less work for a short request and not yet a claim that it is faster.

## Access logs

Set `.access_log(true)` on `App` to write one event for each response through the tracing
subscriber the app already uses. Under `serve`, feature `log` installs Corten's subscriber when
none is set; `router()` and `test()` do not install one. No new log format or dependency is
needed, and the subscriber's control-character escaping stays in force. It is off unless the app
sets it, in the app `corten new` writes too: many deployments already log each request at their
proxy, and a line costs every request (below).

```rust,ignore
let app = App::new(url::router()).access_log(true); // one line per response, target corten::access
```

The event is `INFO` with target `corten::access`. Its fields are `method`, `path` without the
query, `route` when a route answered (its pattern, such as `/items/{id}`), `status`, `bytes` and
`duration`. A route that matched and refused the request is named (its `400`, `405` or `500`);
an unknown URL's `404` names none, including a path an API's prefix holds that a route outside
the API matched, and a segment without the text its route writes after a parameter
(`/feeds/news.rss` for `/feeds/{name}.xml`). A tower layer that sends one request's clones to
several routes is logged with the last one matched. The status and bytes describe the final
response, after the host and cross-site
checks, the error page, a conditional `304`, compression, the app's tower layers and the router's
final HTTP handling (`HEAD` has zero body bytes, as do a `204`, a `304` and a `2xx` to
`CONNECT`, which opens a tunnel rather than sending content). `duration` is the elapsed time until that
response is ready, including the error page's waits, not the time to transmit the body.
`bytes` is the final body's known size, or the string `"stream"` when its size is unknown;
logging never consumes a stream or waits for it to close. A connection rejected before it
reaches the router, such as a head too large for the HTTP parser, has no access event.
A final `100` or `103` from a handler or layer, which the HTTP/1 server cannot send as a final
answer and replaces with an empty `500` before closing the connection, is logged as that `500`;
a `101` is logged as itself.
A response future dropped before its response is ready (a connection that ended, a timeout of
the app's own around the router) writes no line, and none is made up for it; once a response is
ready its line is written, and a later disconnect or a stream that fails does not change it.

An app with its own subscriber can filter or route `corten::access` as it does other tracing
targets, including on the line's fields (`corten::access[{status}]=info`). Filtering the target out
skips the line's clock reads and copies, but keeps the switch's wrapper; leaving the switch off
removes it.

What a line costs, measured in instructions per request (release build, Corten's subscriber
writing to a sink, [design Choice 61](../design.md#choice-access-logs)): a parameter route goes
from about 17,700 to 27,300 (+54%), and an unknown URL's `404` from about 19,100 to 27,300
(+43%). About 1,400 of that is preparing the event; the rest is formatting the line. With the
switch off a request costs what it did before the switch existed, within a dozen instructions.
Writing the line to stdout is not counted: its system call, and any wait when stdout is slow,
come on top.

## Host names

A request for a path takes its host and port from `Host`. When the request-target names its
own authority (host and optional port), that authority takes precedence over `Host`.
[RFC 9112 section 3.2.2](https://www.rfc-editor.org/rfc/rfc9112#section-3.2.2) requires this
for absolute-form targets; Corten also uses the authority of an authority-form target. A different
but valid `Host` does not change the requested host or by itself cause a refusal. The header
still has to pass the checks below. Without `Sec-Fetch-Site`, the write check compares
`Origin` with the requested authority. If a proxy puts an internal address there, the
check trusts that internal origin rather than the public one, and can refuse the app's own
browsers. Forward a path with the public `Host`, or an absolute URL with the public authority.

An app answers a request only when the requested host is `localhost` (or a name under it, such as
`app.localhost`), an IP address, missing (HTTP/1.0, a test's `app().test()`), or a name the app lists.
Any other name gets `421 Misdirected Request` before routing: no handler, middleware, caller
lookup or error page runs (at a route that says `unstaged` too;
[below](#a-route-outside-the-stages)). Otherwise a page on a name someone else controls could point that
name at this machine (DNS rebinding) and then use every route as its own origin, writes
included, since the browser treats the rebound page as same-origin. On loopback, where only this
machine can reach the app, that is the access model it would break, so the check is the default
rather than a setting to remember.

The same check answers `400 Bad Request` to a request HTTP does not allow, whatever names the
app has and with `Policy::any_host()` too, and nothing of the app runs for it either. The
first two are what HTTP requires, and the third is Corten's choice where HTTP leaves one:

1. an HTTP/1.1 request with no `Host` line, or a request with more than one, the same value or
   not, which [RFC 9112](https://www.rfc-editor.org/rfc/rfc9112#section-3.2) (3.2) requires;
2. a `Host` that is not a host and maybe a port, which it requires too: one with a user
   (`user@shop.example`), a path (`shop.example/x`), a space (`shop.example, other.example`),
   a port that is no number, or an IPv6 address with a zone (`[fe80::1%25eth0]`, which
   [RFC 9844](https://www.rfc-editor.org/rfc/rfc9844) took back out of a URI's host). Names
   joined by a comma alone (`shop.example,other.example`) are not refused: a comma is a
   character a host's name may hold
   ([RFC 3986](https://www.rfc-editor.org/rfc/rfc3986#section-3.2.2), 3.2.2), so the value
   is read as one name, as it was before: the `421` unless the app answers to any host, and a
   subdomain where its end is under a name the app lists with a leading dot;
3. by Corten's choice: a `Host` with nothing in it, or a port alone, which HTTP lets a server
   read as its own default name (also beside a target that names its host, as in
   `GET http://shop.example/ HTTP/1.1` with `Host:`, where HTTP has a server ignore what `Host`
   says); an address in brackets that is not IPv6 (`[v1.fe80]`: the grammar has a place
   for an address of a later version, none is defined, and RFC 3986 asks for an error where
   the version is not known); and a target that names its host
   (`GET http://shop.example/ HTTP/1.1`, or a host alone) where that host and port are not
   what a `Host` is held to above: a user in it (`http://user@shop.example/`), which HTTP says
   a server should treat as an error, a port that is no number (`http://shop.example:abc/`),
   or an address in brackets that is not IPv6 or has a zone (`http://[v1.fe80]/`,
   `http://[fe80::1%25eth0]/`). The target's host is the one the request asks for, so the
   check reads it where it would read `Host`, and by the same rule.

Nothing else in a request-target is refused: the check reads none of its path or query, and
whatever the parse lets through there is routed as before, though HTTP says a server should
answer an invalid request-line with a `400` or a redirect. That is a byte outside ASCII (`/café`
from a client that sends it as typed, where a browser sends `/caf%C3%A9`), a `|` or a `%` before
no hex digits, `*` with any method, and a host alone with a method other than `CONNECT`.

The connection stays open after it, as after the `421`: the server knows where the request
ends, so the next one on the connection is answered (one whose body had not all arrived is
closed, as after any answer that leaves a body unread). A request-line that cannot be parsed at
all (a target that is not UTF-8) never reaches the check: the server answers its own bare `400`
and closes. A request with no `Host` is still answered when it is HTTP/1.0, and when Corten's
server did not read it off a connection: a test's `app().test()`, or a `Router` another
library's server calls as a tower `Service`, which answers for the requests it reads (every
other case above is a `400` there too). What reaches the server is what counts: a proxy that
speaks HTTP/1.1 to the app and passes on no `Host` for a client that sent none sends a request
that gets the `400`. nginx as [the deploy guide](deploy.md#nginx) sets it up is not
such a proxy. Run with that configuration (nginx 1.31.9, `proxy_set_header Host $http_host`,
the app with `HOSTS=shop.example`): for an HTTP/1.0 client that sends no `Host`, nginx writes
`Host: app`, the name of its `upstream` block, as the first line of an HTTP/1.1 request, and
the app answers that name with the `421`, as it did before this check refused anything; an
HTTP/1.1 client with no `Host` gets nginx's own `400` and the app is not asked; a client that
names `shop.example`, over HTTP/1.0 or HTTP/1.1, is answered. The first request
refused for each reason is logged, with its method, its path and the reason: never its query,
and of a `Host` or a target's host that is none only the name in it, without a user before or a
path after (no name at all where an `@` comes after a `/`, a `?` or a `#`, since which part is
the user cannot then be told; a name with a space in it is logged as sent). A method, a path or
a name longer than 200 bytes is given by its first 200 and its length, in that line and in the
`421`'s.

A deployed app lists the names it is served under, where the deploy sets `HOST` and `PORT`:

```sh
HOSTS=shop.example,.shop.example   # the domain, and (leading dot) every subdomain
```

or in code, `App::policy(Policy::new().host("shop.example"))`. When a proxy sends a path to
the app and rewrites `Host`, list the name it sends. A health check that calls the app by an IP address, or
by `localhost`, is answered as before, when it sends a `Host` line or speaks HTTP/1.0: a check
written by hand as `GET /health/live HTTP/1.1` with no `Host` is the `400` above. The first refused name is logged, so a deploy that forgot
its name says why it answers 421. An app served under names it cannot list in advance (each
customer's own domain) says `Policy::any_host()` (`HOSTS=*`) and checks them itself; its `Host`
is still read, for the `400` above. The check reads one header and compares it with a short
list; what it does not find there as written (a subdomain's own part, another host's name, any
name when the app answers to any) is also checked, and is taken only when every byte of it
passes; a name with a byte that does not is refused.

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
The `200` sends `Cache-Control: no-store` by default; it is a plain header, so a staged middleware
that rewrites `Cache-Control` or adds a CDN's own caching header can change what caches do with
it. The `503` is a `NoStore` answer and Corten's own failure, so it goes out `private, no-store`
with no CDN caching header whatever a middleware writes on it, as does the error page a browser
gets in its place.

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
    .post(&url::Home)
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
   that wants JSON. So the same form posted without `.mode(..)` is the browser without JavaScript:
   in a test (a debug build) a handler that answers it with a patch, or with a page at a path with
   no `GET`, gets a 500 that says why ([Where a form posts](requests-and-forms.md#where-a-form-posts)).
   `Mode::Action` sends `Prefer: corten-draws=whole` as the runtime does, so a write that answers
   its own page (`req.page(..)`) is answered with the whole document, layout and layout reads
   included ([Choice 66](../design.md#choice-write-own-page-whole)). To ask as a runtime from before
   that, which is answered with `<main>`, add
   `.header(HeaderName::from_static("prefer"), "corten-draws=main")` (`corten::http::HeaderName`):
   a preference the test sets is sent first, and the first is the one read.
4. `.cookie(name, value)` sends a cookie (`answer.cookie(name)` reads one an answer set),
   `.header(name, value)` any other header, `.peer(ip)` the connection's address
   ([`ClientIp`](#the-clients-address)), and `Client::call(method, &route).body(type, bytes)` a body that
   is not a form (JSON, a multipart upload).

The answer is read to its end: `status()`, `headers()`, `text()`, `bytes()`. No server sent it, so
its headers are the app's alone: it has no `Content-Length`, which the server writes from the body
(only a `HEAD`'s has one, from the router, or an answer whose handler set it), and its length is
`bytes().len()`. A live stream has no
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
local port. The stand-in is the other service, not the app, so it keeps none of the app's
defaults (its headers, CSP, shutdown) that the service does not have: it is a server of the
test's own, here axum's as a dev-dependency (`axum = { version = "0.8", default-features = false,
features = ["http1", "tokio"] }`, and `"json"` for a stand-in that reads or answers
`axum::Json`), since Corten depends on no web framework
([design Choice 21](../design.md#choice-own-extractors)):

```rust,ignore
let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
let origin = format!("http://{}", listener.local_addr().unwrap());
let stand_in = axum::Router::new().fallback(platform).with_state(calls.clone());
tokio::spawn(async move { axum::serve(listener, stand_in).await.unwrap() });
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

An audit reads the page and presses no key. A widget's keys (a menu's or the tabs' arrow keys,
Home, End, Escape) are a browser test's to press, with the browser's own keyboard (Playwright's
`page.keyboard.press`), as [`examples/ui-gallery/smoke/`](../../examples/ui-gallery/smoke) does
for every key corten-ui's scripts handle and for Enter and Space on a menu's items. A checker
that dispatches key events from a script in the page tests only what scripts do with them: what
the browser does with a key itself (Escape closing a popover, Tab staying in a modal `<dialog>`)
does not answer a dispatched event, so the platform's own elements read as broken. UI SDK's
`checkPattern` is one (`@ui-sdk/core` 0.1.0-beta.16, run on the ui-gallery's pages in Chromium
159 on 2026-11-23): it found no fault in corten-ui's tabs, choice group and combo box, and
reported a popover menu that Escape does not close and a modal `<dialog>` that Tab leaves,
neither of which a pressed key reproduces, and each `<details>` as no disclosure, for having no
button with `aria-expanded`.

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
Each of `listeners`' sockets asks the system to hold up to 511 connections that finished their
handshake but are not yet accepted (Node's default, and nginx's on Linux), not the standard library's
128 ([design Choice 34](../design.md#choice-listen-backlog)).
On Linux, which caps it at `net.core.somaxconn` (4096 since 5.4), a burst of clients faster than
the server accepts them then waits in that queue rather than a second or more for a resent SYN.
macOS caps it at `kern.ipc.somaxconn`, 128 by default, so there the change takes a raised
setting. Windows 11 held 200 (one run, a Winsock listener on loopback asking for 511) and refused a
connection past them, the client seeing the error after about 2 s; Windows Server was not tried.
A listener of the app's own sets its own.

Each connection accepted from a tokio `TcpListener` (one of `listeners`', or one the app passes to
`serve_on` or `serve_wrapped`) has Nagle's algorithm off (`TCP_NODELAY`), as Go's `net/http` and
nginx do. A feed's patches or a live element's fragments made one after another then go out as
they are made: with it on, one written while the last was not yet acknowledged waited for nginx's
delayed acknowledgement, about 40 ms on Linux
([design Choice 41](../design.md#choice-tcp-nodelay)). A whole answer is one write either way. A
listener of the app's own sets what it chooses, and one that wants Nagle's algorithm calls
`set_nodelay(false)` on what it accepts. A `Router` served as a tower `Service` by another library's
server never passes through Corten's accept, so `TCP_NODELAY` is that server's to set. An answer's
`Content-Length` is that server's to write too, as it is Corten's: the router sets the header only
on a `HEAD`, whose body it drops, and any other answer says its length in its body's `size_hint`,
which hyper writes as `Content-Length` (a `Media::stream_sized` says it in the header itself). A
test that sends a request through `app.router()` reads the length there too.

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

When the step learns something the request needs, use `serve_wrapped_with`: it returns
`(io, value)` and each request receives `ConnectionInfo<T>`. The value is cloned for each
request, never read from a header. [Client certificates](deploy.md#client-certificates)
shows mTLS and how `Identify` reads a verified certificate.

An app behind a proxy that ends TLS needs none of this: `serve` is plain HTTP for the proxy
([Deploying](deploy.md) lists what the proxy must do).
The proxy is also where HTTP/2 or HTTP/3 to browsers comes from (Corten speaks HTTP/1.1), which an
app with live streams needs: over HTTP/1.1 a browser opens about six connections to a host, each
open stream holds one, and a page with a few live elements open in a few tabs uses them up. So
`serve_wrapped` facing browsers directly is for an app without live streams; an app with them
puts a proxy or CDN in front even though it could end TLS itself (why Corten does not speak
HTTP/2 itself: [design Limit 14](../design.md#limit-http1)).
This requirement has an operational cost: a second server and ten proxy-specific concerns
in the deployment guide (the other three rows concern optional caching, health and HTTPS).
The [HTTP/2 prototype](../../bench/http2/README.md) allowed eight live tabs but missed a send
timeout and, by inspection, never returned its h2 watch to idle. Its partial-header probe kept
a response open, when HTTP/1.1's watch is busy too; an idle h2 connection was not tested.
A stream-counting idle watch and a body-stall detector that closes the connection remain
untried. There is no supported `http2` feature yet.
An app whose own default port is not 3000 (another service has it on that machine) passes its
port, and `PORT` still overrides it: `corten::serve_on(corten::listeners(8320).await?, app)`,
rather than setting `PORT` from the program, which is `unsafe` once threads may be running.

## The request path

`App` is one middleware around the routes: the same-origin check, the request signal, the
deadline, the app's middleware, error pages, security headers and compression run in one future
per request, in a fixed order (`corten::middleware`). It is one future of Corten's own; axum's `from_fn`,
which Corten used before, boxed the rest of the stack again for every request (about 700 instructions). Corten's own inline tag (the import map) is the same on every page of a deploy, so the
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

Caching added one header lookup and insert to every response (`Cache-Control`) and two to read
the request's credentials: a few hundred instructions on JSON. Pages got cheaper, because a
page no longer makes a nonce (16 random bytes, base64, and the CSP string around it). An answer
that brings no header but its `Content-Type` has since been given `Cache-Control` with its
scope's other lines in one pass, without the lookup (the last table of this section).

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

When Corten's own router on matchit replaced axum's `Router` and `MethodRouter`
([design Choice 25](../design.md#choice-axum-router), step 2), the same kinds of request were
measured against axum's router (callgrind, release build, jemalloc, in-process `oneshot`, the
difference between 1,200 and 200 requests over 1,000, median of five runs; card-market over one
keep-alive connection, 1,300 less 300 requests, median of three):

| Request | axum's router | Corten's |
|---|---|---|
| card-market's item page | 82,792 (82,790-83,098) | 79,731 (79,618-79,752) |
| card-market's item JSON | 63,008 (62,662-63,203) | 59,754 (59,618-59,862) |
| JSON under `App::api` | 15,726 (15,725-15,726) | 13,112 |
| the same answer from a page route | 21,222 (21,215-21,229) | 18,277 |
| the same with one middleware that only passes it on | 21,466 (21,465-21,472) | 18,562 |
| unknown URL under `App::api` (JSON 404) | 14,094 (14,093-14,094) | 12,171 |
| unknown URL, HTML 404 page | 19,980 (19,979-19,980) | 18,091 |
| an `unstaged` route | 8,479 (8,478-8,479) | 6,932 |

In process the runs of Corten's router did not differ. On the API request most of the difference
is fewer copies of the request and fewer allocations (`memcpy`, `malloc` and `free`, about 1,100
fewer), and the rest is axum's route lookup by id and its futures around the stages. With glibc's
allocator every request in process costs 1,791 to 4,135 less. An unstaged route's checks have
since moved from its handler to the router, which runs them around it, costing 71 to 86 more ([below](#a-route-outside-the-stages)).

A text or bytes answer (`String`, `&'static str`, `Bytes`, a `Media`, a static file) used to
make its header map with its `Content-Type`, with room for six headers, and the security headers
grew it on every request. It now starts with room for twelve, as JSON's map already did (a
page's starts with more): what the default policy leaves such an answer with, HSTS and a
compressed body included (a header beyond those grows the map once, as before). The answer's media type is also read once
where it was read twice. Counted with `crates/corten/tests/router_cost.rs` (callgrind, release
build, in-process `oneshot`, the difference between 1,200 and 200 requests over 1,000, the
median of three runs each, which differed by at most 2; before at `9201e6dd0` with the test as it is at the
after commit, `89e1d0f16`):

| Request | Before, glibc | After, glibc | Before, jemalloc | After, jemalloc |
|---|---|---|---|---|
| text from a route with a parameter | 13,045 | 12,600 | 11,475 | 10,675 |
| text answering a `POST` | 13,734 | 13,122 | 11,851 | 11,057 |
| unknown URL, HTML 404 page | 17,687 | 17,680 | 15,328 | 15,321 |
| text from an [`unstaged`](#a-route-outside-the-stages) route (`ROUTER_TARGET=unstaged`) | 5,225 | 5,571 | 4,418 | 4,525 |

The last row is the cost: an unstaged text answer gets the same room and holds three headers
(its `Content-Type`, `nosniff` and `sandbox`), as an unstaged JSON answer already did, and the
larger block is one glibc's thread cache does not hold.

The last stage used to give every answer each security header and its `Cache-Control` by a
lookup and an insert. Each scope (the app, an area, an API) now keeps the lines those give an
answer that brings none of them, made once when the router is built, and an answer with no
header, or its `Content-Type` alone, is given them in one pass; any other answer (a page, an
answer with a header of its own) has each inserted as before
([design Choice 28](../design.md#choice-fixed-stages)). Counted with
`crates/corten/tests/router_cost.rs` the same way (the median of three runs each, which
differed by at most 9; before at `c9666dc96` with the test as it is at the after commit,
`fad2caf29`):

| Request | Before, glibc | After, glibc | Before, jemalloc | After, jemalloc |
|---|---|---|---|---|
| text from a route with a parameter | 12,207 | 11,716 | 10,694 | 10,244 |
| text from a route under an API (`ROUTER_TARGET=api`) | 9,518 | 9,155 | 8,207 | 7,895 |
| text answering a `POST` (`ROUTER_TARGET=write`) | 12,682 | 12,235 | 11,075 | 10,625 |
| unknown URL, HTML 404 page (`ROUTER_TARGET=missing`) | 17,078 | 17,105 | 15,322 | 15,343 |
| text from an [`unstaged`](#a-route-outside-the-stages) route (`ROUTER_TARGET=unstaged`) | 5,330 | 5,332 | 4,523 | 4,523 |

The 404 page is the cost: an answer that is not given its lines this way pays the test that
tells it apart, 21 to 27 instructions here. The first three rows are also what shows that the
pass is taken. What is sent is the same either way, so no test of answers fails when it is not:
a change to the last stage counts these rows again.

An answer given its scope's lines this way brought its `Content-Type` at most, and none of the
scope's lines is part of an `ETag` or leaves an answer without one, so its
[`ETag`](#the-pages-the-app-keeps) is made without looking through its lines: the hash takes
its body and its type, as it did. Any other answer's lines are searched as before, and the tag
is the same bytes either way. Counted over a socket with
[`bench/request-cost`](../../bench/request-cost/README.md) (instructions a request, the median
of three counts, `e87ad02da` before and `10bfc8a21` after):

| Request | Before | After |
|---|---|---|
| a short text from a page route, a browser's request headers (`text-browser`): tagged, lines given in one pass | 25,840 | 25,275 |
| the same without them (`text`): not tagged | 17,193 | 17,194 |
| a short text from a route under an API (`get`): not tagged | 18,352 | 18,353 |
| a 12 KB page compressed for a browser (`page-browser`): tagged, lines searched | 211,828 | 211,836 |

The cost is one or two instructions on an answer that is not tagged, for the last stage to carry
whether the pass was taken to where the tag is made, and eight on a tagged page.

## Your own middleware

Every request goes through the same stages in the same order, outside in, each needing the one
before it (a route that says `unstaged` goes through none;
[below](#a-route-outside-the-stages)):

1. Compression is negotiated (`Accept-Encoding`); it is applied last. Weights use RFC 9110's
   qvalue grammar (0 to 1, at most three decimals), as `Accept-Language` does. A coding with
   a malformed or repeated weight is ignored rather than given the default weight of 1.
   A comma inside another parameter's closed quoted value does not start a new coding, and
   weight-like text inside that value is not a repeated weight. If the quote never closes, that
   item is ignored and the remaining text is split on commas to recover other codings.
   Only space and tab may surround the weight's `;`, and no whitespace may touch its `=`.
   A coding with no weight still has weight 1.
2. A write another site sent is refused (`Failure::CrossSite`). A browser's gets the error page,
   with the request's `Signal` made for it as in stage 3; its layout reads are not started.
3. The request gets its `Signal`, its nonce and the app.
4. The deadline and the panic catch start (`Failure::TimedOut`, `Failure::Panicked`).
5. The app's middleware, in the order given. The route has been matched, so
   `corten::middleware::MatchedPath` names it (it is absent for an unknown URL, and for a path under an API's prefix
   that a route outside the API matched, which answers with an empty `Allow` whatever its method). Then, for a request under an area's or an API's prefix, its own
   middleware: the areas' (outer first), then the APIs' (outer first), each in the order given.
6. The handler's extractors (a `Caller` is looked up here, only when read), then the handler.
   In an app with layout reads (`App::layout_read`, [views](views.md)), a whole document's `GET`
   starts them as a page route is called, or as a handler takes its `Req`, beside the handler,
   and a write that draws a page rather than redirect starts the reads its page draws once it
   has answered. Either way the page is filled with their values before its answer goes back out
   through 5: a middleware sees the filled page, and the time it measures around `next`
   includes the reads' wait ([design Choice 20](../design.md#choice-layout-reads)).
   A `Public` page, JSON, text or file the app has kept is given here in the handler's place
   ([Caching](#the-pages-the-app-keeps)): stages 1 to 5 ran for the request as for any other,
   and 7 and 8 follow.
7. A failure becomes its route's answer: JSON for a JSON route or a data client, the app's error
   page for a browser. For a failure the request is at fault for (an unknown URL, a wrong method,
   a method no route has (the router's 501, not one a handler or a middleware answers), a refusal other than a 429, a handler's `Refused` included, a request that does not parse),
   the error page starts the layout reads not started yet and waits for them, here, outside 5: a
   middleware sees neither the error page nor that wait.
8. Security headers, `Cache-Control` (private when anything read a caller), then the weak `ETag` on
   an eligible answer to a `GET` or `HEAD` (outside an API and Corten's own paths). A `GET` must
   send `If-None-Match` or explicitly accept a non-identity coding to get a tag: with the `compress`
   feature, only a coding Corten can send, named with a positive weight, counts; without it, any
   named non-identity coding with a positive weight counts, and so does a positive `*`.
   `304 Not Modified` replaces the body when the client's tag matches
   ([design Limit 21](../design.md#limit-etag)), then compression. A middleware sees the `200` with the
   whole body, also when the client gets the `304`.

Corten's stages hold the request once and hand it to the first middleware, or straight to the
handler when there is none. The outer stages keep only what they need to finish the response.
They read the incoming request's mode, credentials and cache validators before middleware (under
an API they do not read the mode: nothing there depends on it). Those
decisions and the error page's saved request are not changed by middleware edits. A `Req` taken
by middleware or the handler reads the headers there, including edits by an earlier extractor.
The WebSocket origin check and the choice of notice cookie also use the URI at extraction.
If middleware replaces a whole URL with a path, those two use `Host`, not the authority the
stages used for admission. As before, an `Origin` matching that `Host` can pass the handshake
check or match for the notice cookie even though admission never judged that name. Preserve the authority when rewriting the path if these must agree.
For an API or data request there is no HTML error snapshot: a session cookie can settle the cache
decision without reading `Authorization`.

Access logging (`App::access_log`) is outside this order, and outside `App::layer`: it sees the
finished response, including refusals that never reached a middleware and an error page or
`304` that replaced what the middleware saw. An `unstaged` route is logged too when enabled.

A step of the app's own is a `Middleware`, given once to `App::middleware`; several are a tuple,
run in order:

```rust
use std::time::Duration;
use corten::{http::{HeaderValue, IntoResponse, Request, Response}, prelude::*};

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
# use corten::{http::{Request, Response}, prelude::*};
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
request on). In an app where no area or API has any, a request goes through the app's middleware
alone, with no boxed step. card-market limits writes this way. A request finds its area's or API's
middleware, with its deadline, body limit and policy, on the route it matched, resolved once when
the app starts. Only an unknown URL and a route that can match a path under another prefix (an
area's, an API's, or one of Corten's own: `/corten/`, the assets') look them up by the request's
path, a scan of the prefixes. Which routes can is counted segment by segment, a parameter
matching one segment and a catch-all the rest: an app's `/{*rest}` can, and so can `/{slug}`
beside an area at `/shop`, but not beside `/shop/desk` or in an app with no areas.

A tower layer still goes around the whole app (`.layer(l)`), outside the router and every stage, for
what must see the raw request first: a cap on body size. It sees the request before its route is
matched, so with no `MatchedPath`, and is made once for the whole app, so a limit it keeps counts
every route's requests together.
There is no layer for one route: what a route needs is in its handler's arguments (an
extractor) and its return type.

### A route outside the stages

A route whose answer must cost as little as the server allows, and is the same for everyone who
can reach it (a public figure behind a CDN, a value every client polls), says `unstaged` in its
routes module, the app's, an area's or an API's; the probes a load balancer sends are Corten's own
`/health/live` and `/health/ready`. It goes through none of the stages above: no same-origin
check, signal or deadline, no middleware (the app's, its area's or its API's), no error page,
security headers, `Cache-Control`, tag, compression or allowed origins. What it keeps adds no
stage: the host check every request meets (a name the app does not answer to gets `421`, and a
request HTTP does not allow `400`),
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` on its answer (below),
a panic answered `500`, and, under an API's prefix, the API's JSON for a failure. Its handler's
answer is otherwise sent as it made it, a raw `Response` too, and every other route keeps every
stage, so the fast route and a page that needs all of them sit side by side:

```rust
use corten::{http::Response, prelude::*};

#[corten::routes]
mod url {
    #[route("/ping", get = ping, unstaged)]
    pub struct Ping;

    #[route("/", get = home)]
    pub struct Home;
}

#[corten::routes(api = ApiRoot)]
mod api {
    #[route("/api")]
    pub struct ApiRoot;

    #[route("/api/figure", get = figure, unstaged)]
    pub struct Figure;
}

async fn ping() -> Response {
    let text = "text/plain; charset=utf-8";
    Response::builder().header("content-type", text).body("pong".into()).unwrap()
}

async fn figure() -> NoStore<JsonResult<u32>> {
    NoStore(Ok(Json(42)))
}

async fn home(req: Req) -> HtmlResult {
    req.page(html! { <html><head><title>"Home"</title><Corten /></head><body><main></main></body></html> })
}

let app = App::new(url::router()).api(api::api);
# let _ = app.router();
```

The listings-feed example serves the sequence its failover benchmark reads this way, bounding its
own wait for Postgres.

The route says it where it is declared, so a reader of the routes module sees which routes skip
the stages. What the compiler can check, it does:

1. The handler takes only the request's method and URL (`Params`, `Method`, `Uri`) and the module's
   `State`
   (`corten::answer::Unstaged`). `Req`, `Signal`, `Nonce`, `Caller` and `ClientIp` read what a stage
   gives; `HeaderMap` and the whole `Request` read the visitor's cookies and credentials, which no
   stage would keep a shared cache from storing; and `Form`, `Json`, `Bytes`, `String` and
   `Upload` read the body, which no deadline there bounds. None compiles there.
2. It answers reads only: `get` (which `HEAD` takes too), never `post` or another method, since
   no same-origin check keeps another site from sending it a write (a form posted to it needs no
   preflight).
3. A routes module with `caller = ..` cannot have one, since every route there takes the caller.
   Nor can a route whose path can answer at a path of Corten's own, as far as the path shows: a
   first segment that is a parameter or a catch-all (`/{section}/ping`, `/{*rest}`, which can
   stand at `/corten/`), a path under `/corten`, or a parameter after `/health`
   (`/health/{check}`). When it starts, the app refuses the rest: one that can match a path the
   app adds (under its assets, the PWA's files and offline page, an API's or area's companion
   routes), one declared outside the module of the innermost area or API whose prefix holds its
   path (`/docs/ping` in the app's routes beside a `/docs` area), whose settings it would skip
   where a reader of that module would not see it, one whose parameter can reach an area's or
   API's prefix (`/pay/{step}` beside an API at `/pay/api`), and one whose path another module
   routes too (`/feeds/{id}.json` beside an unstaged `/feeds/{n}.xml` is the same path to the
   router), where the methods it lacks would answer with no stage.
4. `no_store`, `rows` and `gives(..)` are applied by stages, so an unstaged route does not say
   them; an unstaged handler that must not be kept returns `NoStore<..>` itself. Nor does it say
   `patches`: its handler takes no `Req`, so it cannot answer a patch.
5. It is not a page: `Req::serves` does not send a visitor there after sign-in, and a link to it
   is never prefetched (it does not say `prefetch = ..`). A link a visitor follows to it takes
   `download` or `data-reload`, as one to a `Media` does: without them the runtime fetches it as a
   page, finds it is not one, and loads it again, so the handler runs twice. A link carries
   only what its route says about prefetching, not that it is not a page, so Corten does not add
   `data-reload` for it, as it does not for a link to any route that answers data.

What it gives up is the app's to weigh. Nothing ends its handler at a deadline: one that waits on
another service bounds the wait itself (a pool's acquire timeout, a client's). A middleware of
the app's, its area's or its API's does not cover it, so neither does a rate limit or a check of
theirs, and an API's allowed origins are not sent: a partner's page reads it only if its handler
sends `Access-Control-Allow-Origin` itself, and only with a request that needs no preflight (a
preflight's `OPTIONS` gets the route's 405). A handler that panics is logged and answered `500`
(plain, or the API's JSON under an API's prefix). A 5xx it answers is logged when it is a
`corten::Error`, which logs itself, and under an API's prefix when it is plain text, which the
API's JSON reads and logs as it does for any route there. Under an
API's prefix a failure (the handler's, a path that does not parse, a method it has no handler for)
is the API's Problem Details document, or its `Api::errors` shape, as every failure there is;
anywhere else a failure is sent as the handler made it: a `JsonResult`'s `Err` is the status's
reason as plain text, and a path that does not parse is the extractor's plain-text rejection.
No stage gives its answer a CSP or `frame-ancestors`; a document it builds from what the request
says (HTML, SVG) would run script on the app's origin, where it can read every other page with
the visitor's cookies, but for the sandbox below. An unstaged answer is data (text, JSON, a file)
with its `Content-Type` set, as `&'static str` and `String` set it and a raw `Response` does not
until the handler says. Every unstaged answer gets `X-Content-Type-Options: nosniff`, which keeps
a browser from taking it as another type and a page of the app's from loading it as a script, and
a `Content-Security-Policy: sandbox` header of its own beside any policy the handler set: a
browser enforces every policy it is sent, so whatever type the answer says, a document it sends
(an uploaded SVG a `Media` sends) runs no script on the app's origin. The sandbox leaves data
alone, and a PDF the browser opens (a `Media::inline`, or one with no `Content-Disposition`)
still shows in its viewer in Chrome, Edge and Firefox (checked in Chrome 156, Edge 157 and Firefox
157). Safari was not run: WebKit's bug tracker records that its viewer showed nothing for one
until a fix in December 2024. A PDF that must open in every browser is sent from a route with
stages, or as a `Media::attachment`, which a download saves without making a document. Neither
header reads the answer's type or policy, so no type or policy a handler writes gets past them; an
answer whose own script must run is a page, not an unstaged route's. Its answer has no
`Cache-Control` unless the handler sets one, so a shared cache may keep it by its own rules
([Caching](#caching) describes the stages' rules, which it does not meet): an answer that changes
says so (`NoStore`, which sends `private, no-store`, or `Public`), as the figure above does. One
that sets a cookie is `private, no-cache` (`private, no-store` when it says `no-store`), whatever
caching it says, and it and a `NoStore` one (a `NoStore<Relay>`'s upstream headers included) lose
any `*-cache-control` header and the other caching headers a CDN reads first that
[Caching](#caching) lists (`Surrogate-Control`, `Edge-Control`, ...), so no shared cache hands one
visitor's cookie or one-time answer to another. One that sets a cookie carries that with it, as a
staged answer does: another app of Corten's whose staged middleware relays it inline and takes
the cookie off still sends it as that visitor's ([Caching](#caching)).
A `Public` answer, or one of an answer type of the app's own or a JSON answer (`JsonResponse`,
whose response the handler may replace with a `Public` one), whose handler drew a form's new
submit key ([Caching](#caching)), in `NoStore` or a tuple of headers too, goes out as one that
sets a cookie does, carrying that with it to an app that relays it inline as that one does, and
also loses a tag (`ETag`) it was given: its handler is watched for one, as a staged route's is,
and any other unstaged handler runs with nothing around it.
A request for a method the route has no handler for gets a plain 405 with the router's `Allow`,
or a plain 501 with none when no route in the app has a handler for the method ([error
pages](#error-pages)), and one whose segment lacks the route's suffix (`/feeds/x` for `/feeds/{name}.xml`) a plain 404,
each with the headers every unstaged answer gets, not the app's error page (the API's JSON under
an API's prefix); any other unknown URL is still the app's 404, inside its
stages. A tower layer the app puts around the whole app (`.layer(l)`) still goes around it, and
so does `serve`'s handling of connections: the head's size and time, connection limits, and
shutdown, which lets an unstaged route's request run for the longer of the shutdown grace and the
app's longest deadline, since it records none of its own.

What it saves, measured with callgrind on a release build answering the same JSON in process
(three runs each with jemalloc and glibc, every run the same): 7,030 instructions a request
unstaged (7,076 in an API's module) with jemalloc, where a plain axum router takes 7,059 and a
service of no framework that only answers the JSON 3,190, and 7,834 unstaged with glibc's
allocator (7,882 in an API's module; axum: 8,073; no framework: 3,568). Through the stages
beside it the same answer takes 17,723 (18,985 with glibc). What the route keeps (the host check, the headers above, the panic
catch and an API's JSON) the router runs around its handler in place of the stages, so its 404
and 405 meet it as its handler's answer does; when that was measured it cost 71 instructions
more than the same checks written into the handler (86 in an API's module; 67 and 82 with
glibc), and wall times did not tell them apart.
The host check, with what
carries it to the handler, adds 494 to what the route cost without it, about 400 of that the
check's read of `Host` and its match against the app's names. Refusing what HTTP does not allow
([Host names](#host-names)) added to a request whose first header line is not `Host`: 17 to 19
with `Host` second, and 49 to 54 with it last of a browser's eight lines, about where
Playwright's WebKit on Linux writes it (its Chromium and Firefox write it first, and so does
nginx as the deploy guide sets it up). A request with `Host` first is no longer searched for it
and costs 90 to 126 fewer than before in an app that names its hosts. An app that answers to any
host now reads `Host` too, every byte of it, to refuse one that is no host: 111 to 113 more with
it first, of which 34 to 36 find the line and the rest read `localhost:8080`, and 311 to 312 with
it last of eight
(counted over a socket at `5c7b006dc`, each build in turn, each figure the
difference of the two builds' medians of three runs, with main built a
second time counting within 2 of main but for one request, 6 away, so the 49 is not told from
55; [design Choice 28](../design.md#choice-fixed-stages)). Since its name is read sixteen bytes at a
look, an unstaged request to it costs 84.5 more than before the refusals with `Host` first
(0.75%), 226.9 with it second and 285.6 with it last of eight, most of that for a later line the
two searches for it, and a `GET` through the stages 84.1 (0.51%) with it first and 283.4 with
it last of eight; an app that names its hosts pays 2 to 9 fewer than with the first reader
(`b52f57475` against `fca4ccd58` and main, measured the same way).
[`bench/request-cost`](../../bench/request-cost/README.md) counted an earlier tree of the change,
`ea3983d0b` against `3d84f7de4`, as 17 to 28 fewer a request in an app that answers to any
host and 1 to 9 fewer in one that names its hosts; its hosted job's table counts the change's
last head against its merge base, with names of 6, 40 and 4,096 bytes as well, and a name under
`localhost` in one that names its hosts. Corten's own router ([design Choice 25](../design.md#choice-axum-router), step 2) took
1,547 of these from an unstaged request (1,476 since its checks moved to the router) and about 2,900 from one
through the stages, against axum's router in the same app.

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

A file is sent with the type its extension names: scripts, styles, HTML, JSON and source maps,
web manifests, images, fonts, `wasm`, video (`mp4`, `webm`), captions (`vtt`), text
and XML; any other is `application/octet-stream`. A `GET` of a versioned URL for a file sent as
it is stored (a video, a font or a raster image, which are never compressed; a file too small to
compress; or any file sent unencoded) answers a `Range`, so a `<video>` seeks without downloading
what it skips: one range of bytes is a `206 Partial Content` with its `Content-Range`, a range
the file cannot hold (one that starts past the end, or an empty suffix) is a bare `416` naming
the file's length (never the app's error page), and several ranges or another unit get the whole
file, as RFC 9110 allows. `If-Range` keeps the range only while it names the file's own strong
ETag, and a `HEAD` is answered whole. An old version's URL is answered the same way from this
version's file, so a page left open across a deploy still plays and seeks its clip (Safari on iOS
plays media only from ranges); while a fleet runs two versions, or when a deploy lands between two
ranges, a player that sends no `If-Range` may join ranges of a clip whose bytes changed. A file
sent compressed is sent whole, since the
compressed bytes' offsets are not the file's, and so is the favicon, whose URL outlives every
deploy. No answer sends `Accept-Ranges`: browsers ask for a range without it
([design Choice 37](../design.md#choice-asset-ranges)). The PWA's service worker leaves a range,
and the video or audio a player loads, to the network (its captions and poster are cached like
any versioned file), since its cache holds whole
files and a player does not read a video back from it, so a video does not play offline. A video is
compiled into the program like every static file
([design Choice 8](../design.md#choice-compiled-static-files)), so a short clip fits; serve long
or many videos from storage of their own.

## Caching

Static files, component scripts, the components' stylesheet and the runtime have content-hashed
URLs and are sent `public, max-age=31536000, immutable`; the PWA's worker keeps them. The icon at
`/favicon.ico`, a fixed path, is sent `public, max-age=86400` ([above](#static-files)). Everything
else `App` serves that does not set `Cache-Control` is sent `private, no-cache`, except a route
that says `unstaged`, whose answer is sent as its handler made it
([above](#a-route-outside-the-stages)): the browser
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

`App` still checks what it can see before it lets a shared cache keep the answer (on every route
but an unstaged one):

| The request or response | Sent |
|---|---|
| a full document, no `Cookie` or `Authorization`, nothing read a caller | as asked, plus `Vary: cookie` |
| a request with a `Cookie` or `Authorization`, or one whose handler or middleware read a caller | `private, no-cache` |
| a client navigation, a form answer or a data client's JSON from a page route | `private`, same lifetime: only the document is shared |
| a response that sets a cookie, HTML with the request's nonce, a page that draws a form's new submit key (`SubmitKey::field`), or a `Public` answer (or an answer type of the app's own) whose handler drew one, however it rendered it | `private, no-cache`, logged under `corten dev` |

An answer Corten knows is personal goes out without the caching headers a CDN or proxy reads
before `Cache-Control` that a middleware wrote, whatever its own `Cache-Control` says (none, a
plain `private`, or `no-store`), so a CDN that obeys them does not keep one visitor's answer for
the next: `CDN-Cache-Control` (RFC 9213), `Cloudflare-CDN-Cache-Control`,
`Vercel-CDN-Cache-Control`, `Surrogate-Control`, Akamai's `Edge-Control` and nginx's
`X-Accel-Expires`. Such an answer read a caller, sets a cookie (an unstaged route's too), has the
request's nonce or draws a submit key, or is a `Public` answer to a request with credentials, or
is a tool's answer from an MCP endpoint whose `Tools::auth` found its caller (with
`Tools::authorization` too, any answer that check let through, the list of tools included). The
answer carries that with it: another app
of Corten's whose staged middleware asks it for an answer inline and relays it (as it is, or
changed in place, its cookie taken off included) sends it the same way, though that app's own
request read no caller, while an answer that middleware makes in its place, or a relayed answer
nothing made personal, keeps what it writes. An answer relayed over HTTP carries only its
headers. A `no-store` on it goes out
`private, no-store`: some CDNs ignore a bare `no-store`, and none keeps a `private` answer. A
`NoStore` answer, a `Public` one the third row sends as the browser's alone, a refused write's
error page, the error page for a failure Corten made rather than a handler, and a refusal or the router's own
failure in any other form it goes out in (all below) lose those headers too,
whatever a middleware made of their `Cache-Control` (a `NoStore` one still goes out
`private, no-store`, below, and so does a `Public` one sent as the browser's alone whose header
names `no-store` anywhere: `must-understand`, a second line, or `no-store=1` beside a plain
`private` included). Those names, matched
exactly, are the whole list (a `Public` answer cannot set one either); any other answer keeps the
ones a middleware wrote. An answer that draws a submit key loses a tag (`ETag`) too, not only
the one Corten would make: one the app (`Public::header`), a middleware or a relayed upstream
gave it names a body whose key the browser may already have sent, and a `304` to it would keep
that body.

Keeping a personal answer out of a shared cache by any other means is the deployment's: a name
its CDN is configured to read (RFC 9213 allows any), a layer around the app (`App::layer`, which
runs after Corten settles the answer), and an edge rule that caches whatever the origin says. A
submit key marks the answer it is rendered for: a page, a patch, the layout's reads, and a
`Rendered` placed in one; one made with `req.rendered` marks the request's answer wherever it is
placed (in text or `Json<T>` too). A `Public` route's handler is also watched
for a key it draws any other way, rendered to a string and put in JSON, in text, in a file or
relay it made, or in a page as `raw` markup, and such an answer goes out as a page that draws
one does, in every build, with or without the app's kept answers, and on a route that says
`unstaged` too. So is the handler of an answer type of the app's own (one that implements
`Answer`), since it may hold a `Public` answer on one branch, and of `NoStore` or a tuple of
headers around either (a `no-store` there does not take away a CDN's own caching header), or a
tuple whose header part of the app's own refuses with one, since a refusal is the whole answer.
So is the handler of a page or a JSON answer (`HtmlResult`, `PageOr`, `JsonResponse`, and
`JsonResult<T>`, whose `JsonError` may hold a `JsonResponse`): its `DerefMut` lets the handler
put a `Public` answer it converted in its place (`*page = Public::new(..).into_response()`). The
stages keep the mark past the app's middleware for an answer that comes back through the `next`
of the request they gave it: a middleware that makes a new response of that answer does not take
the mark away, nor one that also gives `next` a request rebuilt without the first one's
extensions or with a signal of its own (a key `req.rendered` drew into text or `Json<T>`
included), on whatever thread it calls or polls `next`. A middleware that asks another router
for an answer of its own (a router it holds, called on its own) and makes a new response of that
one must keep the response's extensions (`Response::from_parts` with the parts it was given):
without them this app may tag that answer, keep it, or keep a lifetime a middleware gives it. The watch
sees what the handler draws itself, before it returns: a key a bare render (`to_html()`) draws in
a task it spawned, a blocking task or a thread of its own is not seen, nor is one drawn as a
body is sent after the handler returned (`Media::stream`, a relay's body, a live stream's
fragments), nor one already in bytes the app relays or in a feed's rows. A render that marks the
answer itself (a page's, a patch's, one made with `req.rendered`) does not rely on the watch and is
seen on whatever thread it runs. So a `Public` handler
draws its forms itself, an answer whose body may draw a key later is not `Public`, says
`Cache-Control: private` itself and carries none of those headers ([live data](live-data.md)),
and a per-visitor key never goes in a feed's rows, snapshot or replay.

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
`accept-language` with `App::messages`, unless the handler took the page's locale from its URL, and on any other answer whose handler, error page or middleware read messages in the language the header asks for (`req.t()`) before the answer left the app: a page, built before or after the read, a screen's JSON, an `App::api` answer, a redirect, the error page of a refused cross-site write). Messages read while a streamed body is written come after its headers: negotiate before answering, or keep that answer out of shared caches. A middleware may change the request's `Accept-Language` only before any extractor that reads the request runs: a `Req` keeps the header as it was when extracted, with `App::messages` the locale first chosen holds for the whole request, and a kept page is keyed on the header the handler sees, so once any `Req` has been extracted, leave the header alone. An answer that depends on another header the middleware read needs that header in `Vary` from the middleware, or a private policy. The [deploy guide](deploy.md#caching) names the setting for nginx, Cloudflare and CloudFront.
A `Public` page in an app with several locales is one copy per `Accept-Language` string in a cache that keys on it, and one language for everyone in one that ignores `Vary`: put its locale in its URL ([Views](views.md#a-locale-in-the-url)), so the cache keys on the URL alone.
`NoStore<..>` keeps an answer out of every cache, the browser's back/forward cache included:
`async fn statement(req: Req) -> NoStore<HtmlResult>`. It goes out `private, no-store` (`private`
for a CDN that ignores a bare `no-store`) with none of the CDN caching headers above, whatever a
staged middleware made of its `Cache-Control`: `NoStore` may be all that says an answer is someone's
(a code in a link, before sign-in). A failure it returns is not kept either: the error page for
an expired code or someone else's statement goes out the same way, as does the error a debug build
sends in place of an answer a browser would show wrongly (a `Refresh` header, a redirect outside
`form-action`). In a
routes module the route can say it instead, `#[route("/statement", get = statement, no_store)]`,
and the handler keeps its own result: a handler that uses `?` (`async fn statement(req: Req) ->
HtmlResult`) is wrapped as it is, where `NoStore<HtmlResult>` would need its body moved into an
`async` block, and every handler the route names is covered, the failures each returns included,
and so is a request its extractors refuse before the handler runs (a path that does not parse, a
`Caller` that is not signed in). A route whose page is ordinary and whose write's answer
carries the secret (a new key shown once) names the methods instead,
`#[route("/account/key", get = page, post = rotate, no_store(post))]`: only `rotate`'s answers
and refusals are `private, no-store`, and the page keeps its usual caching (and the back/forward cache).
Use `no_store` in a routes module and `NoStore<..>` for a handler added by hand (`Api::route`,
`Area::route`). Some failures never reach either: a handler that panics, one past its deadline,
and, for `NoStore<..>`, a request refused before the handler runs. Each sends the app's error page,
which can read the request's `Cookie` and `Authorization` without reading a caller, so Corten never
lets it be shared, as for a refused write: it goes out `private, no-cache` (`private, no-store`
when a middleware's header or its own names `no-store`), with none of the CDN caching headers
above, whoever wrote them. The same holds for the error page in place of the router's own answer
to a request no handler takes (the 404 of an unknown URL, the 405 of a method the route lacks,
the 501 of one no route has, the 400 of a post whose `do` names none of the page's posts or
names two), the PWA's offline page included, which its service worker keeps
whatever its `Cache-Control` says, and for the 404 of a request for the app's static files that
names no file (one the version served lacks, an old version's included) or its 400 for a path that
is not one, and for the 500 Corten sends when a page whose layout reads it fills cannot be read
(its body fails), whatever that page was; a handler's own 404 is its answer, under the rules above. Nor
is the router's own failure shared as it is or as JSON (an API's 404 for a path under its prefix
that a route outside it matched included), whatever a middleware wrote into it or made of it in
place (another status, a redirect, a body of its own): the router marks the answer as it makes it.
A response a middleware makes of its own in its place, whether or not it ran the route
(`next.run(req)`), is the middleware's, a failure included, and keeps what it says. A
request refused before the handler runs is not shared in the other forms it goes out in either,
whatever the refusal is: a `200` its extractor's rejection chose, a redirect, a relayed failure
or a sign-in goes out as it was made, a failure as it is to a client that does not ask for HTML,
or as JSON. Nor is a `Refused` in any form, whoever returns it (an extractor, a handler, a
middleware turning a request away), whatever status a handler (`Error::with_status`, a 404 in
place of a 403) or a middleware gives it after (a redirect, a `200`), nor a panic's or the
deadline's failure as JSON, nor the answer an extractor of the app's error page refuses with in
the page's place (a redirect, or the plain text a failed error page is replaced with); a response a
middleware makes in a refusal's place is its own. Corten marks each of these answers where it makes it, and the mark goes
out with the answer: a refusal made in a task the handler spawned, before the request came in, or
by another app of Corten's that a middleware asks for an answer inline (the error page or sign-in
redirect that app drew in a refusal's place included) is never shared, whatever status the
middleware sends it with. So is every other failure Corten makes rather than a handler: an
extractor's or a protocol's refusal of the request (a body over its limit, too slow, or not what
the route reads, a WebSocket handshake), an MCP endpoint's own errors (a JSON-RPC error it answers
`200` with, a call that names no tool it has or whose arguments do not fit the tool's input, a
refusal before any tool ran; an error result the tool itself returns is the tool's), the 503 of
`/health/ready` (`NoStore` too), a static
file's 416, the 421 for another host, the 403 for a cross-site write, the 500 for an answer whose
header is not one (`private, no-store` when the answer was `NoStore` or a `Cache::no_store()` part
of the same tuple asks for it, whatever order the parts are in), a document with no `<Corten />` or a
kept page that cannot be read, the empty answer sent in place of one whose body failed as Corten
read it to tag or compress it (`private, no-store`, without the answer's validators), and a debug
build's error about the app's code, which keeps a `NoStore` answer's `private, no-store` where it
replaces one. A handler that passes such a failure on with `?`, or gives it another status, keeps
the mark, as one does that met an extractor's rejection as a value (`Result<Json<T>, BodyRejection>`,
a `FormRejection` the extractor made) and passes it on with `?`. A `BodyError` or `UploadError`
is the request's refusal whoever made it: one a handler builds itself and passes on with `?` is
never shared either, so a failure of the handler's own is an `Error` of its own (`Error::status`); a `FormRejection` the handler made
itself (`FormRejection::new`) is its own, passed on or answered, and one that wraps a rejection
(`Error::new(error)`) makes it its own, except an `Error` that holds a refusal (`Refused`), which `Error::new` keeps as the refusal it
is (inside an error of another type, `io::Error::other(error)`, it is the handler's). A handler's own failure is its answer, a plain-text one too: the error
page a browser gets in its place keeps what a middleware wrote, as for its own 404. An unstaged route's `NoStore`
answer goes out `private, no-store` with none of them either
([a route outside the stages](#a-route-outside-the-stages)); its other answers, refusals
included, go out as its handler made them, since no stage runs the cache rule there. A handler
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
anything else). A personal answer (it sets a cookie, read a caller, has the CSP nonce, draws a
form's new submit key, or is a `Cache` answer to a request with credentials) whose header does
not count goes out
`private, no-cache`, or `private, no-store` if any reader could find a `no-store` in its header.

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
headers Corten sets itself (`cache-control`, any `*-cache-control` and the other caching headers
a CDN would obey over Corten's that [Caching](#caching) lists, `vary`, the encoding and length, the
security headers, CORS's `access-control-*`, `corten-*`), those the answer has (`content-type`,
`location`, `content-disposition`) and the connection's (`transfer-encoding`) do not compile. Headers are added to a
success or a redirect; an error is the error page, without them.

A full document never carries `corten-page`, so if a cache hands one to a client navigation by
mistake, the runtime loads the URL as a whole page instead of swapping it in.

### The pages the app keeps

The app is the first shared cache of its own `Public` pages, and of its `Public` JSON,
text and files of 1,024 bytes or more (below). The whole document a `Public` page's handler made for a `GET` that shows nothing about who asks is kept, and given to the next
such request in the handler's place until the answer's shared lifetime ends: `s-maxage` where
the answer has `.shared(..)`, else `max_age`. So a `Public` page's handler does not run for
every request, and what it read may be that old when a visitor sees it, as it already may be
behind a CDN. Count views in a middleware rather than in the handler, and give a page whose data
must show at once a short lifetime, or leave it private. An answer given again carries `Age`,
counted from when the request it was made for reached the handler, so a browser and a CDN count
the lifetime from when the page was made.

A kept page stands where the handler does, after [your own middleware](#your-own-middleware). Every
stage runs for every request: a middleware that refuses, counts or stamps a header still does, and
sees the `200` with the whole body; the security headers and `Cache-Control` are written as for any
answer; and a request that names the page's tag gets its `304`. What a kept page saves is the
handler with what it reads, the render, the tag's hash and the compression, since the hash and each
coding's bytes are made once and stay with the page. On the catalog benchmark's page, marked
`Public` for a minute, a kept page took 14.5% fewer CPU cycles a request where nothing is compressed
and 46.3% fewer where each answer is, at the medians of 12 paired rounds
([design Choice 70](../design.md#choice-kept-pages) has the rounds and what they did not resolve).

What makes it safe is the rule above, checked when the app compiles: a `Public` handler takes
only inputs that cannot tell who is asking. A page is kept when each of them is one of Corten's
own for a page (`Params`, `Form`, `State`, `Req`, `Signal`, `Method`, `Uri`), as Corten fills
it, since all those read of a page's request is in the key below. An `Option` of one is not,
nor a `Form` before the handler's last argument: Corten fills neither, so it would be the app's
own. (`State` is not yet held to this: [#2031 An app can fill `State<T>` with an extractor of its own and read a header under a kept page](https://github.com/corten-run/corten/issues/2031).) An extractor of the app's own that is `Anonymous`
may read another header (a device, a country) and still not tell who asks, so a page whose
handler takes one is made for every request, and an extractor has no way to say otherwise. A
value the URL alone gives (a page number, a filter) is read with `Params` instead, as a query
field of the page's route, plain or a type of the app's own that implements
`corten::route::FromQuery` for a rule over the fields it declares
([Requests and forms](requests-and-forms.md)), or from `Uri` in the handler, and the page stays
eligible to be kept under the rest of the rules below. The request must show nothing
else a page could differ by, and the answer nothing made for one request:

| | Kept and given again | The handler answers |
|---|---|---|
| the handler | takes only Corten's own inputs for a page | takes an extractor of the app's own |
| the request | a `GET` for the whole document, at the URL the router matched | anything the runtime asks for (a navigation's swap, a page fetched whole: a `corten` header), a data client's JSON from a page route, a `HEAD`, a request with a body, a notice sent back, a stream resumed (`Last-Event-ID`), one whose URI a middleware changed or whose target names its host (a proxy's form) |
| who asks | no `Cookie` (the time zone's alone does not count: a `Public` page is written in UTC), no `Authorization`, no caller read by a middleware | any other cookie, `Authorization`, a caller read |
| the answer | a `200` page of a known size, with a lifetime | an error, a redirect, a stream, a lifetime of zero, a page larger than an eighth of the bound, the first answer for a URL once the kept pages are within an eighth of the bound |
| what it carries | | more than 1,024 distinct header names as the route's stages leave it (before the app's middleware and outer stages see the answer, so a name they add or remove does not count), a `Set-Cookie`, the request's nonce, a form's new submit key (drawn by the handler itself: one a bare `to_html()` draws in a task it spawned, a blocking task or a thread of its own is not seen; one `req.rendered` or a page's render draws is seen on any thread), a `Vary` of the app's own |

Nothing is kept under `corten dev`, so the log says instead what a release build does with a
`Public` route's answer to a `GET`: that it would keep it, and for how long, while its store has
room (at `INFO`), or the first reason it does not and what to change (at `WARN`), such as an
extractor of the app's own, a cookie it sets, the request's nonce, a form's submit key, a body
under 1,024 bytes, a status other than `200` or a bound of `0` (`kept_answers(0)`):

```text
WARN corten: /items is Public, but a release build does not keep its answer: it sets a cookie; set it on an answer that is not Public
```

The reasons come from the code that decides what a release build keeps, which runs under
`corten dev` with a store that keeps nothing and gives nothing (writes are counted as a release
build counts them), so they cannot say other than that build does. That an answer would be kept
says it may be, not that it is: the store under `corten dev` holds nothing, so it is never full,
and a full one keeps the answer for a URL only when that URL was asked for before (below). A
page's body is held whole, so its verdict is said as the answer leaves. Any other body of a known
size is said as it ends, not before, and it still reaches your middleware and the browser as it
comes, trailers and all. That verdict is what `corten dev` saw as the body was sent, after the
route answered: a release build reads the body before the answer leaves, within the route's
deadline, and keeps it only if it reads whole there. So "would keep its answer ... if it reads
the body whole within the route's deadline" means a slow body may still miss it, and a body that
failed under `corten dev` is said to have failed as `corten dev` read it, without a status a
release build would answer, since one that fails only once the request's signal has ended
(`Abort::Responded`, as the answer leaves) reads whole in a release build. A
reason the route's type decides (its handler's inputs, an answer that is neither a page nor a
whole body, `unstaged`) is said for any `GET`; one a middleware decides before the handler (a
caller it read, a URL it
changed) or the answer decides, only for a request a kept answer could stand for, one that shows
nothing about who asks. So open the page signed out, or in a private window: a request
with a session's cookie, a navigation inside the app, a `HEAD` or a write is its handler's whatever
the page does, and says nothing. Each route says each verdict once while the app runs (kept with its body held whole, kept if
it reads the body in time, or each reason, whatever its numbers), so loading a page again adds nothing, and a page that answers
another way says the new verdict once; `corten dev` starts the app again on each change, so a
changed page says its verdict again.

A page is kept for the `Host` and the URL it was asked with, path and query: `/items?page=2` is
not `/items`. Where the request's language chooses the page's (`App::messages`, or messages read
with `req.t()` without it, before or after the page was built) it is also kept for the `Accept-Language` it was asked with, as the
header was sent, so `fr` and `fr-FR` are two copies of one page, and a copy given for it names
`accept-language` in `Vary` as it leaves the app, whatever `Vary` a middleware put on it; a page whose locale is in its
URL ([Views](views.md#a-locale-in-the-url)) is one. A URL has at most eight copies, and a new
one takes the place of one not read since it was kept or since room was last made (the oldest
of those, else the oldest of all), so a way of asking seen once does not push out one seen
often.

A write (any method but `GET`, `HEAD`, `OPTIONS` and `TRACE`) drops every page kept at its
path, whatever the query (a named post is `?do=save` at its page's path) and however the path
is escaped, whatever it is answered: a handler or a middleware that refused it (a `409`, a
`422`), failed, passed its deadline or lost its client may have saved first, and a status does
not say, so a `405` for a method the path has no handler for counts too. Work that outlives its
request (`signal.finish`) drops the page again when it ends. So any client can have a kept page
made again by sending a write to its path, and one such request drops every copy kept there, for
every query, host and language. Each is made again when it is next asked for, which costs what
the page cost before the app kept pages and the copy into the store. Only a write that does not
reach the app's middleware is not counted: one another site sent, one for a host the app does
not answer, or one a layer in front (`App::layer`) answered itself. A write
that went through also drops the page at the place on the site its answer
names (`Location`, `Content-Location` or the runtime's `corten-location`). A path from the root
counts. An `http://`, `https://` or `//` URL counts only when its authority matches the write's
[requested host and port](#host-names), compared as written without regard to case
([RFC 9111 section 4.4](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.4)). This applies
to a write with an absolute-form target even though a `GET` in that form bypasses the store.
A page whose handler was reading while a write went through is sent and not kept. So the process that
answered a form posted to its own page, or one that redirects to the list, shows what was saved
on the next load. A write that fails before it names the list (it passes its deadline, or its
client leaves) drops its own path alone.

A write is counted when it is answered, so what it saves must be there for a reader by then, or
be saved under `signal.finish`. One that lands later (a task the handler started and did not
wait for, a database whose readers lag its writer) can leave the page as it was until its
lifetime ends.

Nothing else is meant to drop a page before its lifetime ends (a write to another path does
once in 65,536 times, where two paths share a count, and so does one that began before the app
had made any answer it may keep, below). A write to another path does not drop the
list, and neither does a change made outside a request to the app (a task, a script, another
instance): the page shows it when its lifetime ends, which is what the lifetime says. Purging a
CDN in front does not purge the app, which gives the CDN the kept page again with its `Age`.
A request's own `Cache-Control: no-cache` (a hard reload) gets the kept page too: how long a
page stands is the app's to say. Give a page whose changes must show at once a short lifetime.

`App::kept_answers(bytes)` sets how much is kept: 32 MiB unless set, and `0` keeps none. What is
counted is each page's key (its URL once, its `Host`, and its `Accept-Language` where the page
varies on it), headers and body and each compressed form made of it, with an allowance for what
holds them. The allowance is generous: in one measured example under jemalloc, the template's
allocator, a kept page of 6,124 bytes with four header lines and no compressed form made took
7,112 bytes of allocations (about 7,270 of resident memory) and counted for about 7,800
([design Choice 70](../design.md#choice-kept-pages)); a page with more or longer headers, or
with compressed forms, takes more. Earlier
releases counted the URL twice, so under the same bound a page with a long
URL near its share (an eighth of the bound) may now be kept where it was not, and the store
reaches the point where it is full a little later. Past the bound, a page not read since room was last made goes
first. With room, every page is kept the first time it is made. Once the kept pages are within
an eighth of the bound, keeping one may drop another, so a page is kept only when its URL was
asked for before: a crawler's first walk over more URLs than there is room for, or searches no
one repeats, are answered by the handler and all but a few of them take no kept page's room.
The app remembers the URLs asked for as bits in a table, not as a list, and forgets them all
once an eighth of the bits are set (after 131,072 new URLs at 32 MiB), so a crawler's second
walk over the same URLs is kept as the first was before this rule. The price is one more run
of a page's handler: in a full store the answer to the first request for a URL the app does
not remember is not kept, whether the page is new, or was kept while there was room or before
the bits were last cleared and has since passed its lifetime or been dropped. A store that has filled mostly stays full, since a page past its lifetime keeps
its room until another needs it. Nothing is kept under `corten dev`,
so a change shows on the next load (the log says what a release build keeps, above). An app with no `Public` page and no `Public` JSON, text or file route keeps nothing whatever the
bound, and its writes are not counted, so it pays nothing for pages it cannot keep; one whose `Public` JSON, text and files
are all too small to keep, or streams or files at URLs that name their content, still holds a store, since a body's size is known only when it is made, and
pays for no count by path: writes are counted by path from the first answer the app may keep,
and until then all together, so a write that was under way when that first answer was made drops
every answer kept by the time it ends, and so does work it left (`signal.finish`) each time
some ends. An app's tests keep pages as a deploy does (`App::test`,
`App::router`): a test that changes what a `Public` page shows other than by a write through the
app sets `.kept_answers(0)`. Each process keeps its own: two instances behind a load balancer can
show versions of a page up to a lifetime apart, as two edges of a CDN do, a write drops the page
only in the instance that answered it, and a restart starts empty.

A `Public` route that answers JSON (`Public<JsonResult<T>>`) or text is kept the same way from
a size: its whole body, when that is 1,024 bytes or more, whatever its type and whether or not the
build has the `compress` feature, under every rule above and by the same key (the language too, where the
handler reads it with `req.t()` or `req.lang()`), with, outside
an API (whose answers are not tagged), the tag's hash made once, and each coding's bytes where the
app compresses it. What it saves is the handler with what it
reads, the writing of the JSON, the hash and the compression, and once kept it is given to a
request that accepts no coding as well. That request gets no tag, so where its handler makes
nothing a kept body costs it more than the handler would: in a build with `compress`, 1.3% more
cycles for a file of 8,000 bytes and 3.0% more for one of 1,024 at the mean of five builds of the
same code on two CPUs, and up to 7.8% more in one of the ten. A smaller body is its handler's for every request: the hash a kept body saves grows
with its size, and the instructions asking for it costs do not
([design Choice 70](../design.md#choice-kept-pages)). A route whose bodies are all under the size
stops asking the store after 64 answers in a row of which none was kept (one left out for another
reason, a failure or a form's submit key, counts too, so 64 failures in a row from a route with
bodies kept make it leave as well), but for about one request in 256, so it
costs a load and a draw more than it did before bodies were kept and is found out if its bodies grow; a route
where fewer than about one request in twelve is for a body large enough leaves the store out more
often than not. While it does, a body it kept earlier is made again for each request, and the kept
one may be given after a newer one, within its lifetime. Such a route has one answer at its URL, where a page route has the
document, its swap and its data, so a data client's request (`Accept: application/json` first) is
kept too, as a copy apart from a request that does not ask for JSON first: a handler that takes
`Req` can read which of the two asked. What an API adds for the site that asks
(`Access-Control-Allow-Origin`) is written for each request and is no part of what is kept, so no
site is sent another's. A write drops it as it drops a page: `PUT /api/items/7` drops what is
kept for `GET /api/items/7`, and not the list at `/api/items`, which shows the change when its
lifetime ends.

A file (`Media`), a sitemap and `robots.txt` (`seo::File`) are kept as text is: from 1,024
bytes, whatever the type, so a CSV, an SVG, a sitemap, a PNG or a PDF of that size is kept, with the headers
its handler gave it (its type, its file name), and a short `robots.txt` or a small icon is its
handler's for every request. A picture is kept as it is, since no coding makes it smaller: what
keeping it saves is its handler and the hash of its `ETag`, which is otherwise made from the whole
file for every request that names a coding, as every browser's does. A request with a cookie other than the time zone's, or with `Authorization`, is its handler's,
as for a page: an app whose visitors carry a session, consent or analytics cookie gains this for
those without one, for crawlers and for the caches in front. The app holds a second copy
of a kept file's bytes while it is kept (past its lifetime too, until its room is needed), within what it keeps in all (`App::kept_answers`), so a
file larger than an eighth of that (4 MiB unless set) is not kept. A few large files can fill
what the app keeps and turn its pages out: eight near 4 MiB are the 32 MiB it keeps unless set,
and each query string asked for is a copy of its own. Raise `kept_answers` for such an app, and
send a large file that never changes at a URL that names its content. A file sent as a stream (`Media::stream`) has no body to hold, and
one at a URL that names its content (`Public::immutable`) is left to the caches that keep it for
a year, so neither is kept. A file of a known size that a page route answers in its page's place
(`PageOr<Media>`) is kept as that page would be, also under 1,024 bytes.

A relay, a live stream and a feed are not kept: each is its handler's for every request, and so
is JSON the app holds as bytes (`Json<json::Raw>`), which already keeps its compressed forms where the build compresses and is left out in every build. Nothing that is not `Public` is kept either: a
page for one visitor runs its handler for every request, because a key that had to cover the
caller is where a mistake shows one user's page to another. Cache the data such a page reads in
the app, where it knows when the data changes.

A page route's answer to a `GET` or `HEAD` (the page, a navigation's swap, a patch read again, a
data client's JSON, a `Media` file) carries a weak `ETag` made from the body it rendered, its type
and its `corten-*` headers, and a request whose `If-None-Match` names it is answered `304 Not
Modified`: the answer is still made (unless it is one the app kept), but not compressed
or sent. The browser keeps a `private,
no-cache` page and asks before reusing it, so this is what lets it reuse its copy: on a page loaded
again by a typed URL or a link without the runtime (every browser), and on a reload and the
runtime's navigations and prefetches (Chromium and Firefox; WebKit does not ask on those). Chromium
keeps one copy per URL, so after the runtime fetched a page's swap a reload names the swap's tag and
is sent the document whole, and the other way round. A `304` is the answer as the client has it,
whoever is asking, since the tag is the hash of the answer this request would be sent; it still
carries the answer's headers and cookies. The runtime's headers count because a cache keeps a
stored header the `304` leaves out: a copy that came with a notice must not stand in for an
answer without one. The
tag costs about 3 instructions a byte of a page (2.5 of a file), and a `304` saves the compression
and the body. A `GET` that does not explicitly accept a non-identity coding and sends no
`If-None-Match` (a benchmark, `curl`) is not sent a tag: the hash would cost about a third of the
render. A CDN that fetches pages without asking for a coding therefore gets no tag to revalidate
them, and a proxy in front of the app must pass the browser's `Accept-Encoding` on
([deploying](deploy.md#response-compression)). With `compress`, only explicitly named codings
Corten can send count; without it, any
non-identity coding or `*` with a positive weight counts. In both builds, an otherwise taggable
`HEAD` gets an `ETag` regardless of coding, so a shared cache does not freshen an untagged `GET`
just because the lengths match ([RFC 9111 section 4.3.5](https://www.rfc-editor.org/rfc/rfc9111.html#section-4.3.5)).
Not tagged: a body with this request's nonce or a form's new submit key (`SubmitKey::field`;
either is never the same twice), an answer nothing may
keep (`NoStore`, or `no_store` on its route) or that is immutable, one with an `ETag` or an encoding of its own, a stream, a
relayed page, an error, a write and an API's answer. An answer compression sends as it is (a PNG, a
PDF, `no-transform`) is tagged as well: its `304` saves no compression, but the whole body.
A header of the app's own that only some answers at one URL carry (`Content-Disposition`, `Link`)
is not in the tag, and a cache keeps the stored one
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
another server's shape for a body it refuses too takes the whole `corten::http::Request` and
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
    .auth(move |headers| caller::bearer(headers).and_then(|token| check_token(token, &audience)).ok_or(ToolError::Unauthorized));
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
401 names `Bearer` and the endpoint's name as its realm (`mcp` when the name is empty or not
printable ASCII), for tokens handed out by hand, and tokens are checked per tool call as
before. Either way a 401 for a request that sent a token adds `error="invalid_token"`: one with an
`Authorization` line that is `Bearer ` and something other than whitespace, whether or not
`corten::caller::bearer` can read it (RFC 6750 3.1 leaves the error out only for a request without
bearer credentials); `Bearer` with nothing after it counts as no token, so the client is told
where to get one. The check reads the token with `caller::bearer(headers)`.

The endpoint speaks the MCP revisions in `agent::PROTOCOL_VERSIONS` (`2025-11-25`, `2025-06-18`
and `2025-03-26`). A request whose `MCP-Protocol-Version` header names another, or that sends the
header twice (RFC 9110, 5.3: it holds one revision, not a list), is answered `400 Bad Request` with
a JSON-RPC error that has no `id` (`-32600`, with `data` listing the revisions it speaks as
`supported` and the header as `requested`), as both revisions that define the header require; a
request without the header is read as `2025-03-26`, which they say to assume. An `initialize`
request is not checked: a client sends it before a revision is agreed, and the header is for the
requests after it (an `initialize` without an `id` is a notification, and is checked). A body that
is not JSON, or a batch, gets its usual JSON-RPC error (`-32700` or `-32600`), with a 400 rather
than a 200 when the header names a revision the endpoint does not speak. The header is checked
before the token: a request in a revision the endpoint does not speak cannot be served whoever
sends it, and an `initialize` is still told where to get a token. The code is JSON-RPC's
own rather than one a later revision defines (`-32022` in `2026-07-28`), so a client that tries a
later revision first reads the 400 as an earlier server's, as that revision says, and falls back
to `initialize`.

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
unset (`deadline`, `body_limit`, `errors`) it takes from the API around it, whose middleware runs before its
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
   `Allow`), a method no route has (501) and the deadline's 503. A 4xx message is sent, so write it for the client
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
   methods no route has (501), deadline and refusals all answer as its clients parse them. A `421` for a host the app does
   not answer, or the `400` for a request HTTP does not allow ([Host names](#host-names)), is not the API's (no route ran), and a URL outside the prefix is the pages' 404.
5. `Api::allow_origin` lets one site's pages call these routes from the browser: Corten answers
   its CORS preflight, adds `Access-Control-Allow-Origin` and lets its writes through. The
   pages keep refusing that site's writes. The site authenticates with a token: a write from it
   that carries the user's cookies is refused, and no `Access-Control-Allow-Credentials` is sent.
   It takes one origin, as `Policy::allow_origin` (a site whose pages may write with the user's
   cookies) does: a scheme, a host (a name, an IPv4 address or a bracketed IPv6 one) and a
   port. Both keep it as a browser writes it in `Origin` (RFC 6454) and compare a request's
   `Origin` with that: the scheme and host lowercase, and the scheme's default port (`:443` for
   `https`, `:80` for `http`) and a trailing `/` left out, so `https://partner.example:443/` is
   `https://partner.example` and `https://partner.example:8443` keeps its port. An app webview's
   or a browser extension's own scheme is kept the same way with any port it names, so
   `capacitor://localhost`, `tauri://localhost` or `chrome-extension://<id>` can be allowed
   ([why](../design.md#choice-allowed-origin-schemes)). `capacitor://localhost` is every
   Capacitor iOS app's default origin, so prefer a distinct `server.hostname`; Capacitor on
   Android defaults to `https://localhost` and Tauri on Windows to `http://tauri.localhost` (or
   `https://`), loopback origins any local server can also serve in an ordinary browser. A name
   may hold `_`; a Unicode name is written in its `xn--` form, as browsers send it. A value no
   `Origin` could equal (no scheme, a path, a query, a user, a wildcard, a comma-separated list,
   `null`, or a scheme no page sends from: `file`, `data`, `blob`, `javascript`, `about`,
   `ws`, `wss`, `ftp`) panics at startup and names the setter.
6. `Json` in the prelude is `corten::Json` (feature `json`). It reads a request body into a
   `FromJson` (item 8) with the value and the rejections axum's `Json` gave (recorded from axum
   0.8.9 and held by a test): a body with a JSON content type (`application/json`,
   `application/problem+json`, either with parameters such as a `charset`) is read by Corten's
   reader, and by `serde_json` only where that reader gives up, so the content type does not
   choose the reader. What it writes is a `ToJson`: derive it (`#[derive(ToJson)]`, also in the
   prelude) on the response type. It needs no `Serialize` unless the app's own code writes the type
   with serde or it is a feed row; an agent tool's output is a `ToJson` too, and its input a
   `FromJson`. The derive lays the JSON out when the crate compiles, so a response copies one byte
   string between each pair of values instead of writing every key, quote and comma, into a `Vec`
   sized from the type's last response that the body keeps. It reads `#[serde(...)]` and writes the
   bytes `serde_json` would. A `#[serde(flatten)]` field whose type is a struct that derives
   `ToJson` is written in place, its members laid out the same way; an attribute it cannot follow
   (`flatten` of a map or an enum, `serialize_with`) does not compile. A field whose type has only
   `Serialize` (an id or a date from another crate) is written by `serde_json`, and so is a whole
   field around one (`Vec<theirs::Id>`, a map whose values are one) or a map whose key is not a
   `JsonKey` (`BTreeMap<theirs::Key, u32>`). An app's own key type is a `JsonKey` when it is an
   externally tagged enum of unit variants that derives `ToJson`, or by `impl
   corten::json::JsonKey`, whose `write_key` writes the one JSON string serde writes for it, quotes
   included (an agent tool's output that holds a hand-written `ToJson` or `JsonKey` is parsed
   before it is sent). `serde_json::Value` is a `ToJson`, as above.
7. Numbers are written as serde_json writes them, a whole float as `2.0`
   ([Numbers in JSON](#numbers-in-json)).
8. To read JSON another service answers, derive `FromJson` (in the prelude) and read it with
   `corten::json::from_slice` or `from_str`. The derive writes the type's serde `Deserialize` too,
   so it needs no second derive (one beside it does not compile). Corten's reader takes the fields
   the type declares and skips the rest; on anything it does not follow (an escaped key, a missing
   or duplicate field) `serde_json` reads the text instead, so the value and every error are
   `serde_json`'s. It reads `#[serde(...)]` as serde's derive does and refuses one it cannot follow
   (`flatten`, `deserialize_with`); a field of a type with only `Deserialize` is read by
   `serde_json`, and an empty `impl corten::FromJson for T {}` lets such a type be read alone. A
   `#[derive(Fields)]` form input or a `#[derive(UrlValue)]` enum is a `FromJson` already (with
   feature `json`, and has its schema with `types`), so `FromJson` beside either does not compile
   either. A generic one (`Offer<T>`) is a `FromJson` wherever its `Deserialize` applies, read by
   serde_json rather than Corten's reader, and a `UrlValue` enum with a `#[serde(other)]` variant
   reads any other word as that variant (its schema is any string). A form input whose fields borrow
   from the input (`&'a str`, `#[serde(borrow)]`) cannot be a `FromJson`, which reads owned values;
   give it owned fields (`String`) to read it from JSON.

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
# #[cfg(feature = "types")]
# {
use corten::prelude::*;

#[derive(ToJson)]
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
# }
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
`Operation::bearer("..")` for a key or token it checks, or `Operation::api_key("x-api-key", "..")`
for a header of an existing API's own, which no 401 challenge can name (each a security scheme
of the document, which `Option<Caller<..>>` makes optional), or with
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
naming the type, and serving it costs a clone of its bytes. Distinct Rust types with the same
name, even the same printed path from two dependency versions, get separate component schemas
(`Payload`, `Payload2`) and references to their own definitions. Avoid the name `Problem` for an
app schema when using the default Problem Details response: it takes that component name. A test
keeps a copy in the repository, for a generator or a reviewer to diff, with `corten::openapi::sync`,
which rewrites the file and fails the test when the routes changed, as `Types::sync` does:

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
   which is a `ToJson` and so can be one field of a derived response or of an agent tool's output
   (its schema is any JSON value). `Raw` has no `Serialize`, so a feed row, which serde writes,
   holds `Box<serde_json::value::RawValue>` instead (serde_json's `raw_value` feature; for
   generated types its schema is any JSON value). JavaScript's number form comes from
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
        // A client is pinged every PING (30 s, say) and closed once it has sent nothing, not even
        // a pong, for IDLE (a minute): a deadline from the last frame heard, which a send arm
        // added to this `select!` does not restart. A ping or the idle close that waits past SLOW
        // (10 s, say) for the client to take it ends the socket; the other sends here wait up to
        // `App::send_timeout`, where the watchlist bounds every send by SLOW.
        let mut heard = tokio::time::Instant::now();
        let mut ping = tokio::time::interval_at(heard + PING, PING);
        loop {
            let message = tokio::select! {
                message = socket.next() => {
                    heard = tokio::time::Instant::now();
                    message
                }
                _ = ping.tick() => {
                    let sent = tokio::time::timeout(SLOW, socket.send(Message::Ping(Default::default())));
                    if !matches!(sent.await, Ok(Ok(()))) {
                        break;
                    }
                    continue;
                }
                () = tokio::time::sleep_until(heard + IDLE) => {
                    // Idle: say goodbye as going away (1001), with the reason.
                    let idle = CloseFrame { code: CloseCode::Away, reason: "no answer to pings".into() };
                    let _ = tokio::time::timeout(SLOW, socket.close(Some(idle))).await;
                    break;
                }
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
   site's page gets a 403. A browser sends `Sec-Fetch-Site` only to a secure origin, Chromium
   and Firefox not on a handshake at all, and browsers too old for it not on a write; then the
   `Origin` must be an `http` or `https` origin on the [requested host](#host-names): the same
   name and port as the target's authority, or as `Host` when the target names none,
   a port left out being its scheme's default (80 for `http`, 443 for `https`, so
   `https://app.example` is `Host: app.example:443`). Another scheme (an app's own,
   `capacitor://localhost`) is refused. Under `Policy::hsts` the `Origin` must also be `https`,
   or loopback (`localhost`, a name under it, `127.0.0.0/8`, `[::1]`), which browsers count as
   secure over plain `http`. So an app with `hsts` refuses every write and handshake from a
   plain-http page other than loopback, in every browser: a server on its host's port 80, its
   own name before the browser has cached HSTS, and also the app itself reached as
   `http://192.168.1.5` or `http://tool.lan`, so an app served that way must not set `hsts`.
   Without `hsts` the scheme is not compared and such a page passes: behind a proxy that ends TLS
   the app cannot tell which scheme it is served over (it reads no `X-Forwarded-Proto`;
   [design Limit 26](../design.md#limit-origin-scheme)), so an app served only over HTTPS says
   so with `hsts`. A route whose callers must not be browsers at all refuses them in its
   `Identify` (a request with `Origin` or `Sec-Fetch-Site`).
2. A request that does not ask to switch gets a 400: the extractor serves tunnels too, so it
   cannot name a required protocol in the `Upgrade` header a 426 must carry. An HTTP/1.0
   request does not ask, whatever its headers say, since HTTP/1.0 cannot switch (RFC 9110,
   7.8). A WebSocket handshake with a version other than 13 gets a 426 with
   `Sec-WebSocket-Version: 13`, `Upgrade: websocket` and `Connection: upgrade`, kept on the
   error page and JSON failures; one with no version is taken as one of another version, which
   tells the client which to send. A handler that gives that error a 400 (`with_status`) keeps
   only `Sec-WebSocket-Version: 13`; any other status (a 404 that hides the socket) carries none
   of the three. A route that does not take `Upgrade` never switches: only an `Upgrade` makes
   the 101, so a socket opens only where a route declared one. A URL that is a socket and also
   something else (a page, or a gateway's relayed answer) takes `Option<Upgrade>`, `None` when
   the request does not ask, and returns `SwitchOr<A>`: `upgrade.websocket(run)?.into()` or
   `SwitchOr::Answer(page)`. Its failures are answered as `A`'s are, and a switch it asks for is
   checked as above.
3. The request's own `Signal` ends with the 101, so the work gets its own, which aborts with
   `Abort::Shutdown` when the app begins to shut down; the work is not waited for.
   `App::send_timeout` still holds on the switched connection: a write the client has made no
   room for in 60 seconds fails with `TimedOut`, and the socket should end there. The
   connection counts against `App::max_connections` until the work drops the stream, and
   nothing of Corten's ends one where neither side sends: the work ends idle sockets (a deadline
   from the last frame heard, with pings for a client that only listens, as above and in
   `examples/watchlist`'s `socket.rs`) and should bound how many it keeps, or they take the cap
   from every other request.
4. Message size, compression, what may wait to be sent and per-message checks are the
   WebSocket library's settings and the route's code: Corten does not read frames.
5. `upgrade.switch(headers, run)` answers with an upstream's 101 and its headers instead, for a
   tunnel that relays another server's switch and then passes bytes both ways
   (`tokio::io::copy_bidirectional`).
6. Only HTTP/1.1 connections served by `corten::serve` switch; an HTTP/2 request (no extended
   `CONNECT`) and a test's `app().test()` get a 400. A 400 needs no `Upgrade`, so it has none
   (nor `Connection`), and HTTP/2 forbids both headers anyway.

`corten::Relay::new(status, headers, body)` is another server's answer passed on as it came, for a
gateway or a backend for a frontend: its status, its headers less the hop-by-hop ones, and its body
as it arrives (`Body::from_stream(res.bytes_stream())` from reqwest). A failure status keeps the
upstream's body, never the error page or the JSON error. The app's security and cache rules still
apply, except that a `Content-Security-Policy` the upstream sent replaces the app's: a relayed
page's scripts were written for its own policy (their nonces and hosts), which the app's would
block. Who may frame it stays the app's: its `frame-ancestors` is enforced beside the upstream's
policy, and its `X-Frame-Options` (none, for a page another origin may frame) replaces the
upstream's ([below](#a-policy-for-part-of-the-app)).
Without an upstream policy, the app's applies. A `Permissions-Policy` the upstream sent is kept the
same way, and a relayed page without one gets the app's. A streamed body is passed on as each piece
arrives. Corten compresses no relayed body, buffered or streamed, an event stream included, so a
long relayed stream holds no compression context: the encoding is the upstream's. A relay that
should be compressed forwards the client's `Accept-Encoding`, and the upstream's encoded body goes
on as it is, as long as the HTTP client does not decode it (for reqwest, leave its `gzip`, `brotli`
and `zstd` features off). When the client leaves, the body is dropped, and the upstream request with
it. What else to drop (`Set-Cookie`) is the route's to decide.

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
names included (`OPTIONS`, `PROPFIND`), so the upstream answers them, not Corten's 405 or 501.
Since the upstream may implement any method, an app with a relay anywhere implements every one:
at a path the app routes itself, a method its route lacks is a 405 with that route's `Allow`,
`PROPFIND` included, never a 501 ([error pages](#error-pages)). Corten
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
   handler takes the whole `corten::http::Request`, reads the body with
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
    extract::bytes_up_to,
    http::{Request, StatusCode},
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
        // Not a 401: no HTTP authentication scheme would let the vendor send it another way.
        return Err(Error::status(StatusCode::FORBIDDEN));
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
| `Refused::sign_in(&route)` | 303 to the route (`corten-location` to the runtime's fetch when the route is on another site or names a place) | `corten-location`, and the runtime goes there | JSON 401, without `WWW-Authenticate` |
| `Refused::unauthorized(challenge)` | the error page, `Failure::Refused` (401), with `WWW-Authenticate` | the error page, swapped in, with `WWW-Authenticate` | JSON 401, with `WWW-Authenticate` |
| `Refused::forbidden()` | the error page, `Failure::Refused` (403) | the error page, swapped in | JSON 403 |
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
   a session cookie on the pages, `Caller<Partner>` from a key sent as a bearer token
   (`Authorization: Bearer <key>`) on a `JsonResult` route, where a missing key is a JSON 401
   with `WWW-Authenticate: Bearer realm="partners"`. A type that is a rule over another
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
   A 401 says how to send credentials (RFC 9110 requires it): `Refused::unauthorized` takes the
   `Challenge` that goes in `WWW-Authenticate`, `Challenge::bearer("partners")` for a key or
   token in `Authorization` (RFC 6750, whose challenge names a realm), with
   `.param("error", "invalid_token")` when the one sent is wrong, and no error when the request
   sent none or another scheme's credentials (RFC 6750 3.1). The lookup reads the key with
   `corten::caller::bearer(&parts.headers)`, which returns the token of RFC 6750's credentials
   (`Bearer` in any case, one or more spaces, the token trimmed) and `None` for no
   `Authorization`, another scheme's credentials, `Bearer` with nothing after it, or credentials
   it cannot read as one token (a value outside visible ASCII, or two `Authorization` lines, which
   RFC 9110 does not let a client send): `None` gets the challenge alone, and a token the app does
   not know adds the error. A lookup that wants RFC 6750's `invalid_token` for unreadable
   credentials treats an `Authorization` that is present but unreadable as a malformed token. The
   reader does not check the token's syntax (RFC 6750's `b64token`); a malformed one is a wrong
   one. `Challenge::basic(realm)` makes a
   browser show its own sign-in prompt. A key in a header of the app's own
   (`X-Api-Key`) has no scheme to name, so send it as a bearer token; an API whose clients
   already send that header takes the key as a bearer token too and challenges `Bearer`. Another
   scheme is a `const` of the app's (`const NEGOTIATE: Challenge = Challenge::new("Negotiate");`),
   so one that is not a token does not compile (called elsewhere, `new` checks it as it runs);
   a parameter's value is always sent quoted and in ASCII, and is checked when the challenge is
   made, so a test that sends a refused request finds a mistake in it; a realm from configuration
   goes into a `Challenge` the app builds once at startup, keeps in its state and clones for each
   refusal, so a bad one stops the app from starting. `Refused::sign_in`'s 401
   to a data client has no challenge: a session cookie has no HTTP authentication scheme. A lookup
   that also takes a token should refuse a request that sent a wrong one with `unauthorized`.
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
   text in theirs, `/feeds/{name}.atom`), or the app does not compile. A route that says
   `patches` in its routes module takes only a `get` handler that returns `HtmlResult<Patches>`
   there too (with no `get`, or another, it does not compile). Both checks are made when the
   code that mounts the route is compiled: `cargo build`, and `cargo test` when a test or the
   library reaches it, but not `cargo check`, nor `cargo test` when only a binary's `main`
   mounts it ([design Limit 11](../design.md#limit-caller-types)).
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

No site may show a page in a frame (`frame-ancestors 'none'`, and `X-Frame-Options: DENY` for
browsers that do not read it), so another site cannot lay its own page over one of the app's to
steer a click. An unstaged route's answer is sent with neither unless its handler sets one: it
is data, not a page, and runs no script ([A route outside the stages](#a-route-outside-the-stages)).
A widget other sites embed (an item's card, a chart) is an area whose policy names them,
`p.frame_ancestors("https://partner.example")`, and every other page keeps the denial; the card
market's `/embed` area takes them from `EMBED_ORIGINS`. A source is a host or a scheme, or
`'self'` for the app's own pages; `*` or a bare scheme (`https:`) lets any site frame them. On
a staged route the policy decides `X-Frame-Options`, whatever a handler, middleware or relayed
upstream sets: pages another origin may frame are sent none (it cannot name one) and pages only
the app may frame `SAMEORIGIN`. Who may frame a page stays enforced where the app's CSP is not: a
relayed answer that brings its own CSP, and under `Policy::report_only` a page another origin may
frame, are also sent an enforced `Content-Security-Policy` of their `frame-ancestors` alone.
Frame read-only pages: a
parent on another site gets none of the app's `SameSite` cookies (Corten's cookie helper makes them
`Lax`), so the page is drawn signed out there, but a parent on the same site (`blog.example.com`
framing `app.example.com`) gets them, so the page is signed in and a write from it carries the
session while the parent can lay its page over the button. A link meant to leave the frame (to a
page that may not be framed) opens in the parent's tab: `<base target="_top">` in the framed page's
head, with `data-no-prefetch` around its links, since a hover's prefetch would fetch a page the
frame never shows.

To read a part of the page again from a script, use a hidden GET `data-patch` form with
`requestSubmit()`, or render `ReadAgain::from` for a server-chosen delay
([example](scripts.md#reading-a-part-again)). `patch(html, signal?)` takes `TrustedHTML`, not
the text read from a fetched response; it does not pass a script's input through the runtime's policy.

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
   the [requested host](#host-names) when `Sec-Fetch-Site` is absent, or neither header, as a
   test or a client that is not a browser sends,
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

Every answer but an unstaged route's is sent with `Referrer-Policy: strict-origin-when-cross-origin`: other sites get the
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
| `WrongMethod` | the route has the URL but not the method, which the app implements elsewhere (`Allow` is kept) | 405 |
| `UnknownMethod` | the route has the URL and no route in the app has the method (no `Allow`); a 501 a handler or a middleware answers is `Failed`; the router's turned into another status, or given a body that is not plain text, by a middleware keeps what the middleware wrote, a plain-text body is `Rejected` with status 501, and an empty body of unknown size (a wrapping or streaming middleware) is sent as a bare 501 | 501 |
| `CrossSite` | a write another site sent, refused before anything else ran | 403 |
| `Refused { status }` | a `Caller` refused, with nowhere to sign in | 401, 403, 429 |
| `Unidentified { detail }` | who is asking could not be looked up (`Refused::unavailable`), unlike a handler's own 503 | 503 |
| `Rejected { status, detail }` | the path, the query or the body did not parse | 400, 415, 422 |
| `Failed { status, detail }` | the handler returned an `Error`, or the deadline passed while it waited for the client to send the body | 500, or its status; 408 for the body |
| `Panicked { detail }` | the handler panicked | 500 |
| `TimedOut` | the handler ran past its deadline (`App::deadline`, or its area's or API's), not waiting for the body | 503 |
| `Offline` | the PWA's offline page | 200, so the worker keeps it |

A method is one the app implements when some route in it has a handler for that method, or
when it is `GET`, `HEAD` (which every server implements, RFC 9110 9.1) or `OPTIONS` (whose
caller asks what a resource allows, which the 405's `Allow` tells it). A route that takes every
method (`any = relay`) makes every method one the app implements, since the server behind it
may. At a URL a route has, a method the app implements and the route does not is a 405 with the
route's `Allow` (RFC 9110 15.5.6); any other (`PROPFIND`, `QUERY`, `PUT` in an app that routes
none, or `get`, since a method's name is case-sensitive) is a 501 with no `Allow` (9.1), since
no resource here supports it and the route's `Allow` is not the answer. The path is matched first: an unknown URL is a 404 whatever its
method, as it is for a method the app does implement. Only a request that reaches a route's
405 checks the method again, so a request a route answers costs no more (within 3 instructions
of Corten's own code when measured, [design Choice 25](../design.md#choice-axum-router), Stands on). Such a 501 is a
refusal of a method the app does not implement, not a failure: Corten does not log it as an
error. Scanners send `PROPFIND`, `TRACE` and made-up methods to any site, so these raise a
proxy's or a CDN's 5xx rate, and a client that retries every 5xx by default (Polly's
`HandleTransientHttpError`, .NET's standard resilience handler) retries them unless told not
to. CloudFront's stock `5xxErrorRate` and Cloudflare's error-rate notifications cannot tell them
apart, since neither filters by method (Cloudflare's Monitors may; the deploy guide says what to
check); an alert built from access logs leaves out `status = 501 AND method not in the app's served methods` (the methods
its routes name, with `GET`, `HEAD` and `OPTIONS`), which hides neither a handler's `501` to
a method it serves nor any other 5xx. An app with an `any` route answers no such `501` and
leaves nothing out ([Deploying](deploy.md#monitoring)).

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
error page goes out `no-store`. It is `private, no-store` for `NoStore` and `no_store`, whatever a
middleware made of the failure's header, and on a page Corten never lets be shared
([Caching](#caching): in place of a failure Corten made rather than a handler, a refusal, or the router's own
404, 405, 501 or a named post's 400), where a `no-store` written by hand goes out so as well and none of the failure's
CDN caching headers is kept. On the page for a handler's own failure, a `no-store` written by hand
goes out bare unless the page is personal.

That page for a handler's own failure (its 404, its `Error`) keeps what a middleware wrote,
`CDN-Cache-Control` and `Surrogate-Control` included, as the handler's answer would: whether it
may be shared is the app's policy. So a middleware that tells a CDN to keep every answer must not
do so for an error page that reads the raw `Cookie` or `Authorization` header itself (an
extractor of the app's own, with no `Caller`): a CDN would keep one visitor's page and give it to
the next. Have such a middleware leave failures alone (`res.status().is_client_error()` or
`is_server_error()`), or have the error page find who is asking through a `Caller`, which makes
its answer private.

The error page is an async function of the `Failure` and then extractors, as a handler's
arguments are, with the state they read given beside it (`()` for none). A layout that shows
who is asking takes the caller as a page does, so a signed-in user who mistypes a URL or is
refused still sees themselves signed in, in their theme:

```rust,ignore
async fn error_page(failure: Failure, req: Req, viewer: Option<Caller<Viewer>>) -> HtmlResult {
    let (title, text) = match failure {
        Failure::UnknownMethod => ("Method not supported", "This site does not support that request method."),
        Failure::NotFound
        | Failure::WrongMethod
        | Failure::CrossSite
        | Failure::Refused { .. }
        | Failure::Unidentified { .. }
        | Failure::Rejected { .. }
        | Failure::Failed { .. }
        | Failure::Panicked { .. }
        | Failure::TimedOut
        | Failure::Offline => failure.default_text(),
    };
    req.page(html! {
        <Layout req={&req} viewer={viewer.as_deref()} title={title}>
            <h1>{title}</h1>
            <p>{text}</p>
        </Layout>
    })
}
// App::new(url::router()).error_page(error_page, store.clone())
```

Match `Failure` exhaustively without a `_` arm, as the error page from `corten new` does.
When Corten adds a variant, the compiler points to the place where you need to decide what
its page should say instead of silently drawing a catch-all page for a new status. Group
named variants in one arm with `failure.default_text()` to use the default page's English
title and message in your own layout ([design Choice 67](../design.md#choice-exhaustive-failure)).

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

`failure.detail()` is what went wrong, under `corten dev` only; in production it is logged as
the error itself, so Corten's log line names each error under the message as `error.sources`
(the reset connection under an HTTP client's "error sending request"). A subscriber of the
app's own decides how to show them: `tracing-subscriber`'s text format does the same, its JSON
format writes the message alone. Each source's message is its library's own and can quote what it
read (a JSON error names the value it could not parse, so part of an upstream answer), as the
message above it could already (an HTTP client's names the URL); none of it reaches the client.
A debug build's error about the app's own code (a component it
does not serve, a `Refresh` header, a write redirected outside `form-action`, a page answering
a post to a path with no `GET`, a patch answering a browser's plain request
([Where a form posts](requests-and-forms.md#where-a-form-posts)))
is the exception:
it is set in every debug build, so a router test's error page names it.
A JSON route's failures, a data client's and every failure under `App::api` are a JSON
Problem Details document instead
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
