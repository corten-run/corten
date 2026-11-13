# Deploying behind a proxy or CDN

[Back to the guides](../../README.md#documentation)

Corten speaks HTTP/1.1. HTTP/2 or HTTP/3 to browsers and a shared cache come from a proxy or a CDN
in front of `corten::serve` ([design Limit 14](../design.md#limit-http1)), which usually ends TLS too (the app can,
[`serve_wrapped`](app.md#your-own-listeners)). This page is what that proxy has to do
for a Corten app, the nginx configuration it was checked with, the settings for two CDNs, the
release profile an app builds with, how its image builds beside other apps', and what to know when
monitoring it.

For live streams this is a requirement, not just a choice of where to end TLS: another server
to configure, update and operate. Nine of the twelve rows below are proxy-specific concerns;
row 5 is conditional on a shared cache, while health checks (9) and HTTPS policy (12) also apply
without a proxy. Not every row is a new cost caused by the HTTP/2 requirement.
An opt-in prototype passed an eight-tab h2 check but missed a flow-controlled send timeout;
its idle watch also remained permanently busy by inspection. The partial-header probe kept
a response open, which leaves the HTTP/1.1 watch busy too, so it did not establish a lost
header-timeout guarantee. The idle h2 case and a connection-level body-stall detector remain
untried. [Choice 25](../design.md#choice-axum-router) and the
[partial weighing](../../bench/http2/README.md) record the evidence and reopening tests.

## What the proxy must do

| | What | Why |
|---|---|---|
| 1 | pass the browser's `Host` as it came, port included, and list the names in `HOSTS` | the app answers `421` to a name it does not know ([Host names](app.md#host-names)); a write or a WebSocket handshake without `Sec-Fetch-Site` (Chromium and Firefox sent none on one here) is checked by comparing its `Origin` with `Host` (name and port, a default port the same written or left out, and an `https` origin under `Policy::hsts`; [WebSockets](app.md#websockets-and-relays)), so with any other `Host` the app's own pages cannot open a WebSocket (measured: 403 with nginx's `$host`, which drops the port) unless `Policy::allow_origin` names the public origin; nginx's `proxy_pass` sends the upstream's name (`app:8080`) unless told otherwise |
| 2 | set `X-Forwarded-For`, and list the proxy's addresses in `PROXIES` | otherwise every request comes from the proxy ([The client's address](app.md#the-clients-address)) |
| 3 | serve browsers and native clients HTTP/2 or HTTP/3 | each open live stream holds a connection, and over HTTP/1.1 a browser has about six per host ([Connection](live-data.md#connection)); a native app's `URLSession` caps HTTP/1.1 connections the same way and HTTP/2 lifts it, while OkHttp's cap counts calls whatever the protocol and is raised in the app ([Surfaces](../architecture.md#native-apps-next-not-built)); on a mobile link one connection for all of them also saves the other handshakes (HTTP/3 can keep it across a switch from Wi-Fi to cellular, where the client speaks it and the edge supports migration) |
| 4 | pass event streams on as they are written | a buffered stream arrives late or not at all (below) |
| 5 | key a shared cache on `Vary` | one URL answers a document, a navigation and JSON ([Caching](#caching)) |
| 6 | let the app's 4xx and 5xx bodies through | they are the app's error pages and redrawn forms (nginx's `proxy_intercept_errors` is off by default; [Requests and forms](requests-and-forms.md)) |
| 7 | reuse a connection to the app for less time than `App::header_timeout` | the app closes an idle connection after it (30 seconds), and a request the proxy sends on it as it closes fails; nginx 1.29.7 and later reuse upstream connections by default, for 60 seconds, so set `keepalive_timeout` in the `upstream` block (below) |
| 8 | expect a connection to the app per open stream | streams multiplexed over one HTTP/2 connection to the proxy still each hold an HTTP/1.1 connection to the app, so `App::max_connections`, if set, counts them |
| 9 | check `/health/live` and `/health/ready` | both answer to an IP address or `localhost` as the host, so a health check needs no name; `/health/ready` answers within 800 ms (`App::ready_within`), so a probe timeout of one second or more reads its answer ([Health](app.md#health)) |
| 10 | allow request bodies as large as the app's largest form, and pass a large upload on as it arrives | nginx refuses a body over `client_max_body_size` (1 MB) with a page of its own, before the app can answer it in the form; and it holds the whole body before passing it on (`proxy_request_buffering on`), so a route that reads a body as it arrives (`pieces_up_to`) gets a `location` of its own with its limit and `proxy_request_buffering off` (below) |
| 11 | keep a quiet WebSocket open, or let the app ping it | nginx closes a proxied connection that sends nothing for `proxy_read_timeout` (60 seconds), a WebSocket included; Corten's `Upgrade` sends no pings of its own, so a socket that may go quiet longer pings from the app or gets a longer timeout in its `location` |
| 12 | set `Policy::hsts` in the app when it is served only over HTTPS, even when the proxy or CDN already sends `Strict-Transport-Security` | the app sees plain HTTP from a proxy that ends TLS and reads no `X-Forwarded-Proto`, so `hsts` is how it knows its pages are `https`: with it, a write or a WebSocket handshake without `Sec-Fetch-Site` from a plain-http page on the app's host is refused, and without it that page passes ([design Limit 26](../design.md#limit-origin-scheme)); it also keeps a redirect's notice in the `__Host-` cookie ([WebSockets](app.md#websockets-and-relays)) |

### Live streams

`<corten-live>` and feeds answer `text/event-stream` with `X-Accel-Buffering: no`, which tells
nginx not to buffer that response whatever `proxy_buffering` says, and write a keep-alive comment
on a quiet stream every 15 seconds, under nginx's 60-second `proxy_read_timeout`. Measured with
`examples/watchlist`'s `/live/trades` (an event a second) through nginx 1.27: without the header,
nginx's default there (HTTP/1.0 to the app, `proxy_buffering on`) and `gzip on` for
`text/event-stream` each sent no byte in 25 seconds; with it, every case delivered events 1,000 ms
apart, as the app wrote them, compressed or not. A CDN must not cache a
stream either; Corten sends it `no-cache`. A `Relay` passes an upstream's stream on with the
upstream's headers, so one without the header is buffered unless its `location` says
`proxy_buffering off`.

## nginx

Checked with nginx 1.27 in front of `examples/watchlist`: the browser smoke test
(`scripts/smoke.mjs`) passes through it over HTTP/1.1, and HTTPS negotiates `h2` and streams events
a second apart. `proxy_cache` was checked in front of `examples/card-market` ([Caching](#caching)).

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      '';
}

upstream app {
    server 127.0.0.1:3000;
    keepalive 16;              # reuse connections to the app...
    keepalive_timeout 25s;     # ...for less than App::header_timeout (30 s)
}

proxy_cache_path /var/cache/nginx/app keys_zone=app:10m;
proxy_cache_key $scheme$host$request_uri;   # the browser's host, not the upstream's name

server {
    listen 443 ssl;
    http2 on;
    server_name shop.example;  # HOSTS=shop.example
    ssl_certificate     /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;

    location / {
        client_max_body_size 8m;   # more than twice the app's body limit (2 MiB); see below
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # PROXIES=127.0.0.1
        proxy_set_header Upgrade $http_upgrade;                        # WebSockets (Upgrade)
        proxy_set_header Connection $connection_upgrade;
        proxy_cache app;       # keys on Vary; stores only answers sent public
    }
}
```

nginx's limit decides who answers a body that is too large. The app reads a body past its limit
by as much again (at most 64 MiB more; an `Upload` reads 64 MiB past its own limit) and answers
it with its own 413 or the form redrawn; a body over `client_max_body_size` gets nginx's page
instead. One rule sizes every `location`: the larger of twice its whole-body limit and its
largest `Upload` limit plus 64 MiB. The `8m` above covers the default 2 MiB body limit and forms
whose uploads stay under 8 MiB; a larger upload there gets nginx's page, not the form redrawn. A
prefix with a large `Upload::limit` or a raised body limit (`Api::body_limit(16 << 20)` for a
document API) gets a `location` of its own sized by the rule. This sizing is reasoned from what
the app reads past a limit; the nginx check above did not send bodies over it.

A route that reads a large body as it arrives (a file `PUT` read with
`corten::extract::pieces_up_to`) gets a `location` of its own in the same `server`, so nginx
neither refuses it at the forms' limit nor holds all of it before the app sees a byte. Its
`client_max_body_size` is the route's `max` and the 64 MiB the app reads past (or `0`), so the
app's own 413 (the API's shape, or the handler's) is what the browser reads for a body up to
that size (a limit of only `max` would have nginx refuse first); past it, the browser reads
nginx's page. A prefix that also serves downloads keeps
`proxy_cache app;` here too:

```nginx
    location /files/ {
        client_max_body_size 1088m;     # the route's max (1 GiB) and the 64 MiB the app reads past
        proxy_request_buffering off;    # pass each piece on as it arrives
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
    }
```

`keepalive` needs `proxy_http_version 1.1` and a `Connection` header other than `close`, which
the map gives a request that is not a WebSocket. Leave `proxy_ignore_headers` without `Vary`
and `Cache-Control`.

A WebSocket needs `proxy_http_version 1.1` too: a proxy that passes `Upgrade` on over HTTP/1.0
gets an `Option<Upgrade>` route's other answer (its page) and an `Upgrade` route's 400, since
a server ignores `Upgrade` in an HTTP/1.0 request (RFC 9110, 7.8).

[`examples/corten-site/deploy`](../../examples/corten-site/deploy/README.md) is a whole deploy
written out: this configuration with a certificate, limits on what one address may ask for
and hold, with what each was measured to do, a limit on the live streams one reader and all
readers may hold and, for a machine with 512 MB, the streams asked for as zstd or not
compressed at all, the app as a systemd service on one small machine, and a workflow that
ships each change and puts the release before back when the new one does not answer.

## Caching

A page route answers several clients at one URL: the whole document, a client navigation
(`corten: nav`), a form's answer, and JSON for `Accept: application/json`. Only the document may be
shared, and only from a `Public` handler ([Caching](app.md#caching)); its answers say `Vary: corten,
accept, accept-encoding`, `cookie` when the request had none, and `accept-language` with
`App::messages`. A cache that keys on the URL alone hands the stored document to every request for
it. Measured with nginx's `proxy_cache` in front of `examples/card-market`: by default it keys on
`Vary`, and each kind of request got its own answer; with `proxy_ignore_headers Vary`, a
navigation, a JSON request and a brotli request after the first document each got that document
(no `corten-page`, no encoding). The runtime loads a navigation answered with a document as a
whole page, so it still works, more slowly; a data client gets HTML where it asked for JSON.

| Cache | Pages are cached | To key on `Vary` |
|---|---|---|
| nginx `proxy_cache` | when a location has `proxy_cache` | nothing: it honors `Vary` unless `proxy_ignore_headers Vary` |
| Cloudflare | only under a Cache Rule that makes them eligible ([default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)) | the same rule's Vary setting ([Vary](https://developers.cloudflare.com/cache/concepts/vary/)): `corten`, `cookie` and `accept` passthrough (normalizing reorders `Accept`, and the app reads its first type), `accept-encoding` normalize, `accept-language` normalize with `languages` set to the app's locales (normalizing strips regions otherwise) |
| CloudFront | by its cache policy | the cache policy lists `corten`, `accept` and, with messages, `accept-language` as headers and the cookies the app reads as cookies (CloudFront sends the app only the cookies its policies name), and turns on gzip and brotli ([cache key](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-the-cache-key.html)) |

A public page whose locale `Accept-Language` chooses is stored once per distinct header string
where the cache keys on it raw (CloudFront's cache key, nginx): `en-US,en;q=0.9` and `en` are two
copies of one English page, so the hit rate falls with the variety of browsers. Cloudflare's
normalizing above keeps one per locale. Elsewhere, put the locale in the page's URL (a
`Locale<Msg>` route field and `req.set_locale`, [Views](views.md#a-locale-in-the-url)): its answer
does not vary on `accept-language`, so a cache keys it on the URL and keeps one copy per locale.
A cache behavior whose pages all take their locale from the URL need not forward the header;
one that still negotiates (the `/` that sends a visitor to their locale, a 404, a page without a
locale in its URL) must, or CloudFront sends none and every visitor gets the default locale. Every
page says its locale in `Content-Language`.

The Cloudflare and CloudFront rows are from their documentation, not run here. Check a deploy
the way it was measured: request a public page as a document, then the same URL with
`corten: nav` and with `Accept: application/json`. The second must carry `corten-page` and the
third must be JSON.

## The release profile

`corten new` writes `lto = "thin"` under `[profile.release]` in the app's `Cargo.toml`, and
leaves the rest at Cargo's defaults (`opt-level = 3`, 16 codegen units). In a Cargo workspace,
Cargo reads profiles only from the root `Cargo.toml` (and warns about a member's), so an app that
becomes a workspace member moves the section there. Corten's own workspace, which builds the
examples and the benchmarks, adds `codegen-units = 1`, as do the other Rust apps in
`bench/fullstack`, so its numbers compare like with like. `corten dev` builds the debug profile,
so neither changes the edit-reload loop; they change the release build, its binary and the
server's cost per request.

Measured on card-market at `eb8589c8` in `rust:1-bookworm`, each profile set through
`CARGO_PROFILE_RELEASE_LTO` and `CARGO_PROFILE_RELEASE_CODEGEN_UNITS`, on a desktop under load,
so the build times are noisy. A clean build is card-market and its dependencies from an empty
target directory; a rebuild follows a line appended to `src/views.rs`. Two rounds each:

| Profile | Clean build (s) | Rebuild (s) | Binary (bytes) | Item page, instructions per request |
|---|---|---|---|---|
| `lto = "thin"`, `codegen-units = 1` (the workspace's) | 376, 517 | 129, 184 | 7,524,648 | 88,214, 88,353, 88,407 |
| `lto = "thin"` (the template's) | 291, 361 | 99, 135 | 9,436,048 | 87,620, 87,400, 87,425 |
| Cargo's default (no `[profile.release]`) | 393, 206 | 96, 43 | 9,402,208 | 89,341, 88,890, 88,898 |

The instructions are the item page through card-market's router in process under callgrind (a
temporary test, not kept, that requests items 1 to 500 in turn with `oneshot`; 1,200 requests
less 200, per request), three rounds. One round through the release
server under callgrind (1,300 requests less 300) gave the item page 107,545, 99,111 and 110,121
instructions and the item's JSON 75,378, 76,608 and 77,872, in the same order; one round is not
enough to separate the profiles, so the claims below rest on the in-process numbers.

Thin LTO serves the page in about 1.7% fewer instructions than Cargo's default. It costs build
time: in the second round, the quieter one for the default, its rebuild took 135 s against 43 s and
its clean build 361 s against 206 s. One codegen unit against sixteen costs about 1% more per page in
process, builds about a third slower and makes the binary a fifth smaller. The workspace keeps it to match the benchmarks' other apps and the published numbers,
not for speed.

## Building the image

The Dockerfile `corten new` writes compiles the app with two BuildKit
[cache mounts](https://docs.docker.com/reference/dockerfile/#run---mounttypecache), which stay on
the builder between builds and are not part of the image.

The target directory is a cache of the app's own, `id=<app>-target` with `sharing=locked`: a
rebuild compiles only what changed, and two builds of the same app take turns, since each touches
its sources first and cargo decides what is current by file times. BuildKit names a cache by its
`id`, and by its path when it has none, so without the `id` every image on the builder that mounts
`/src/target` would share one cache, and each build would wait for every other one, whatever app it
was. With it, apps on one Docker host build alongside each other. Two apps of the same name on one
host would still share a cache; give one of them another `id`. Each app keeps a full target cache
of its own on the builder's disk, every dependency it compiled included, so two apps with the same
dependencies compile them once each, at the same time if they build at once, and store them twice.
The caches a Dockerfile without an `id` used, `/src/target` and `/usr/local/cargo/registry`, stay
on the builder until `docker builder prune` removes them.

Downloaded crates are one cache for every app on the host: cargo's whole home, `/var/cache/cargo`
(`CARGO_HOME`), shared. The home is mounted rather than its `registry` alone because cargo keeps its
lock on the downloaded crates there (`.package-cache`), so builds that download at once wait for
each other's lock instead of writing the same files unseen. Setting `CARGO_HOME` also moves where
cargo reads its global configuration and credentials; the `rust` image has none, and a project's
`.cargo/config.toml` is read as before.

Every app's build on the host mounts that home, so a file one build leaves in it applies to every
other's: a `config.toml`, a `credentials.toml`, or a program in its `bin/`, which cargo runs for a
subcommand ahead of one on `PATH`
([External tools](https://doc.rust-lang.org/cargo/reference/external-tools.html#custom-subcommands)).
A private registry's token goes to the build through a
[secret mount](https://docs.docker.com/reference/dockerfile/#run---mounttypesecret) or the
`CARGO_REGISTRIES_<NAME>_TOKEN` environment variable of that `RUN`
([registries](https://doc.rust-lang.org/cargo/reference/config.html#registriesnametoken)), never into
the shared home.

Cache mounts are not exported with `--cache-to` or restored with `--cache-from`, so on a new
builder, such as a hosted CI runner's, the build starts from clean.

## Monitoring

The router answers a request whose method no route in the app has (`PROPFIND`, `TRACE`, a
scanner's made-up method) with `501 Not Implemented`, as RFC 9110 9.1 says, at any URL a route has
([Error pages](app.md#error-pages)). It is a refusal, not a failure: the app does not log it as an
error. A scan therefore raises a proxy's or a CDN's 5xx rate.

CloudFront's stock 5xx metric cannot leave these out: `5xxErrorRate` has no dimension but
`DistributionId` and `Region`, so a CloudWatch alarm on it counts every `501`
([Types of metrics for CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html)),
and Cloudflare's Origin Error Rate alert filters only by domain and sensitivity, its Advanced
Error Rate alert by status code and IP address
([Platform Notifications](https://developers.cloudflare.com/notifications/notification-available/));
none of these filters by method. Cloudflare's Monitors run a SQL query with filters by field
([Monitors](https://developers.cloudflare.com/notifications/monitors/)) and may be a built-in way
to filter by method, but whether their `events.httpRequests` dataset carries the method is not
said on the pages read here; check its columns
([Datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/)) before relying on it.
Otherwise an alert that leaves these out is built from the access logs,
which carry the method and the status (CloudFront's `cs-method` and `sc-status`,
[Standard logging reference](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logs-reference.html);
Cloudflare Logpush's `ClientRequestMethod` and `EdgeResponseStatus` or `OriginResponseStatus`,
[HTTP requests](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)),
or from a proxy's own logs or the app's own metrics.

The filter to leave out is `status = 501 AND method not in the app's served methods`, where the
served methods are the ones its routes name, with `GET`, `HEAD` and `OPTIONS` always among them.
Both halves matter. Nothing on the wire marks the router's `501` apart from another, and a
handler's or a middleware's `501` has no `Allow` either, so leaving out every `501` would also
hide the app's own: a handler's `Error` at 501 is a failure, logged as an error as any 5xx
`Error` is. And leaving out every 5xx to a method outside the list would hide more than the
router's answer, such as a maintenance middleware's `503`, which can answer any method. With
both, the filter hides only a `501` to a method no route serves, which only the router or a
middleware answers; a list that falls behind a new route hides that route's `501`s, never its
`500`s. An app with a route that takes every method (`any`, a relay) answers no such `501`, so
it leaves nothing out.

A client that retries every 5xx by default retries these `501`s too, where it did not retry the
`405` an older Corten answered: Polly's `HandleTransientHttpError` and the retry of .NET's
standard resilience handler (Microsoft.Extensions.Http.Resilience) both handle any status of 500
or more. Each takes a setting for which answers to retry; a client of the app that sends a method
no route serves can leave 501 out of it.
