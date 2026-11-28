# Deploying behind a proxy or CDN

[Back to the guides](../../README.md#documentation)

Corten speaks HTTP/1.1. HTTP/2 or HTTP/3 to browsers and a shared cache come from a proxy or a CDN
in front of `corten::serve` ([design Limit 14](../design.md#limit-http1)), which usually ends TLS too (the app can,
[`serve_wrapped`](app.md#your-own-listeners)). This page is what that proxy has to do
for a Corten app, the nginx configuration it was checked with, the settings for two CDNs, the
release profile an app builds with, what a profile-guided build gained on two apps, how its image builds
beside other apps', and what to know when monitoring it.

For live streams this is a requirement, not just a choice of where to end TLS: another server
to configure, update and operate. Ten of the thirteen rows below are proxy-specific concerns;
row 5 is conditional on a shared cache, while health checks (9) and HTTPS policy (12) also apply
without a proxy. Not every row is a new cost caused by the HTTP/2 requirement.
An opt-in prototype passed an eight-tab h2 check but missed a flow-controlled send timeout;
its idle watch also remained permanently busy by inspection. The partial-header probe kept
a response open, which leaves the HTTP/1.1 watch busy too, so it did not establish a lost
header-timeout guarantee. The idle h2 case and a connection-level body-stall detector remain
untried. [Choice 25](../design.md#choice-axum-router) and the
[partial weighing](../../bench/http2/README.md) record the evidence and reopening tests.

## Client certificates

An app that ends TLS itself can pass a verified client certificate from the handshake to
every request on that connection. Use `serve_wrapped_with` instead of `serve_wrapped`:
the step returns `(io, value)`, with `value: Clone + Send + Sync + 'static`. This example
uses `tokio-rustls` 0.26 and rustls 0.23. `client_roots` is the app's trust store of client
certificate authorities, not a store populated from what a client sends; `server_chain`
and `server_key` are the app's own certificate chain and private key.

```rust,ignore
use std::sync::Arc;
use corten::ConnectionInfo;
use tokio_rustls::{rustls, TlsAcceptor};

#[derive(Clone)]
struct ClientCertificate(Arc<[u8]>); // leaf certificate, DER; cheap to clone

let verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(client_roots)).build()?;
let mut config = rustls::ServerConfig::builder()
    .with_client_cert_verifier(verifier) // requires and verifies a client certificate
    .with_single_cert(server_chain, server_key)?;
config.alpn_protocols = vec![b"http/1.1".to_vec()]; // Corten speaks HTTP/1.1
let acceptor = TlsAcceptor::from(Arc::new(config));

corten::serve_wrapped_with(corten::listeners(3000).await?, move |tcp| {
    let acceptor = acceptor.clone();
    async move {
        let tls = acceptor.accept(tcp).await?;
        let leaf = tls.get_ref().1.peer_certificates()
            .and_then(|chain| chain.first())
            .ok_or_else(|| std::io::Error::other("verified client certificate missing"))?;
        let certificate = ClientCertificate(Arc::from(leaf.as_ref()));
        Ok::<_, std::io::Error>((tls, certificate))
    }
}, app).await?;
```

A handler takes `ConnectionInfo<ClientCertificate>`. An `Identify` implementation borrows
the same value with `ConnectionInfo::<ClientCertificate>::of(parts)` and maps the certificate
to the app's account and permissions, refusing an unknown or unauthorized certificate with
`Refused::forbidden()`. Return that identity through `Caller<Partner>` when a page or its
layout depends on it ([Caller](app.md#who-is-asking)). Certificate verification proves the
trust relationship configured above, not permission to use every route. Never treat an
unverified certificate or a certificate copied from a request header as that proof.

Reading `ConnectionInfo` through its extractor or `of` makes the answer private; it does
not itself key a layout by the certificate. A required value missing from a request answers
500; `Option<ConnectionInfo<T>>` yields `None` (for example on a plain-HTTP listener). Several
facts, such as the certificate, SNI name and ALPN protocol, belong in one app-defined struct.
SNI and ALPN describe the connection, not an authenticated caller. The typed wrapper avoids
replacing a framework extension when the app's value happens to have the same type.
A handler of a documented API ([OpenAPI](app.md#an-openapi-document)) may take either form; it
adds nothing to the document.

`App::header_timeout` includes the handshake, `max_connections` counts it, and `send_timeout`
and shutdown drain still apply to the resulting connection. The existing `serve_on` and
`serve_wrapped` APIs insert no connection-info extension. A proxy that ends TLS cannot pass
this value: its connection to the app is not the client's TLS connection. An app accepting
proxy assertions needs a separate authenticated trust boundary, not this API. Direct TLS
does not add HTTP/2; the live-stream limitation at the top of this guide still applies.

## What the proxy must do

| | What | Why |
|---|---|---|
| 1 | forward the requested authority, port included, and list the names in `HOSTS` | for a path sent upstream, put the public host and port in `Host`; if the upstream target is a whole URL, put the public authority there. Its authority takes precedence over `Host` ([Host names](app.md#host-names)). An internal address there makes the write check trust the internal origin rather than the public one when `Sec-Fetch-Site` is absent. The app answers `421` to a name it does not know. A write or a WebSocket handshake without `Sec-Fetch-Site` (Chromium and Firefox sent none on one here) is checked by comparing its `Origin` with the requested authority (name and port, a default port the same written or left out, and an `https` origin under `Policy::hsts`; [WebSockets](app.md#websockets-and-relays)), so forwarding the wrong authority can prevent the app's own pages from opening a WebSocket (measured: 403 with nginx's `$host`, which drops the port) unless `Policy::allow_origin` names the public origin; nginx's `proxy_pass` sends the upstream's name (`app:8080`) unless told otherwise |
| 2 | set `X-Forwarded-For`, and list the proxy's addresses in `PROXIES` | otherwise every request comes from the proxy ([The client's address](app.md#the-clients-address)) |
| 3 | serve browsers and native clients HTTP/2 or HTTP/3 | each open live stream holds a connection, and over HTTP/1.1 a browser has about six per host ([Connection](live-data.md#connection)); a native app's `URLSession` caps HTTP/1.1 connections the same way and HTTP/2 lifts it, while OkHttp's cap counts calls whatever the protocol and is raised in the app ([Surfaces](../architecture.md#native-apps-next-not-built)); on a mobile link one connection for all of them also saves the other handshakes (HTTP/3 can keep it across a switch from Wi-Fi to cellular, where the client speaks it and the edge supports migration) |
| 4 | pass event streams on as they are written | a buffered stream arrives late or not at all (below) |
| 5 | key a shared cache on `Vary` | one URL answers a document, a navigation and JSON ([Caching](#caching)) |
| 6 | let the app's 4xx and 5xx bodies through | they are the app's error pages and redrawn forms (nginx's `proxy_intercept_errors` is off by default; [Requests and forms](requests-and-forms.md)) |
| 7 | reuse a connection to the app for less time than `App::header_timeout` | the app closes an idle connection after it (30 seconds), and a request the proxy sends on it as it closes fails; nginx 1.29.7 and later reuse upstream connections by default, for 60 seconds, so set `keepalive_timeout` in the `upstream` block (below) |
| 8 | expect a connection to the app per open stream | streams multiplexed over one HTTP/2 connection to the proxy still each hold an HTTP/1.1 connection to the app, so `App::max_connections`, if set, counts them |
| 9 | check `/health/live` and `/health/ready` | both answer to an IP address or `localhost` as the host, so a health check needs no name, only the `Host` line every HTTP/1.1 client sends (a probe written by hand with none gets `400`, unless it speaks HTTP/1.0; [Host names](app.md#host-names)); `/health/ready` answers within 800 ms (`App::ready_within`), so a probe timeout of one second or more reads its answer ([Health](app.md#health)) |
| 10 | allow request bodies as large as the app's largest form, and pass a large upload on as it arrives | nginx refuses a body over `client_max_body_size` (1 MB) with a page of its own, before the app can answer it in the form; and it holds the whole body before passing it on (`proxy_request_buffering on`), so a route that reads a body as it arrives (`pieces_up_to`) gets a `location` of its own with its limit and `proxy_request_buffering off` (below) |
| 11 | keep a quiet WebSocket open, or let the app ping it | nginx closes a proxied connection that sends nothing for `proxy_read_timeout` (60 seconds), a WebSocket included; Corten's `Upgrade` sends no pings of its own, so a socket that may go quiet longer pings from the app or gets a longer timeout in its `location` |
| 12 | set `Policy::hsts` in the app when it is served only over HTTPS, even when the proxy or CDN already sends `Strict-Transport-Security` | the app sees plain HTTP from a proxy that ends TLS and reads no `X-Forwarded-Proto`, so `hsts` is how it knows its pages are `https`: with it, a write or a WebSocket handshake without `Sec-Fetch-Site` from a plain-http page on the app's host is refused, and without it that page passes ([design Limit 26](../design.md#limit-origin-scheme)); it also keeps a redirect's notice in the `__Host-` cookie ([WebSockets](app.md#websockets-and-relays)) |
| 13 | pass the browser's `Accept-Encoding` on to the app, and its `If-None-Match` for a page the proxy does not answer from a store of its own | a page `GET` is tagged only for a request that accepts a coding or names a tag, so without the first a browser that holds no tag is never given one; a `304` for a page the proxy did not store comes only from the app, so without the second that page is sent whole on every reload ([Response compression](#response-compression)) |

### Live streams

`<corten-live>` and feeds answer `text/event-stream` with `X-Accel-Buffering: no`, which tells
nginx not to buffer that response whatever `proxy_buffering` says, and write a keep-alive comment
on a quiet stream every 15 seconds, under nginx's 60-second `proxy_read_timeout`. Measured on
2026-11-20 with `examples/watchlist`'s `/live/trades` through nginx 1.31.9: the sample delivered
events a second apart over HTTP/1.1 and HTTPS `h2`, with steady-state gaps of 1,000 to 1,020 ms
for identity, gzip and zstd. With the header ignored, nginx 1.27.5's default HTTP/1.0 upstream
and `proxy_buffering on` sent no byte in 25 seconds. nginx 1.31.9's default HTTP/1.1 upstream
delivered the events even with the header ignored, as 1.27.5 did with the sample's explicit
HTTP/1.1. Forcing HTTP/1.0 upstream or having nginx gzip `text/event-stream` still sent no byte
in 25 seconds when the header was ignored. With the header honored, both delivered events as
the app wrote them. A CDN must not cache a stream either; Corten sends it `no-cache`. A `Relay`
passes the upstream's headers on, so a stream without the header can be buffered. Set
`proxy_buffering off` in its `location` to turn buffering off there.

## nginx

Checked on 2026-11-20 with nginx 1.31.9: both configurations below passed `nginx -t`. In front of
`examples/watchlist`, the browser smoke test (`scripts/smoke.mjs`) passed in Chromium, Firefox and
WebKit over HTTP/1.1 and again over HTTPS with the test's local fixtures on TLS. A separate HTTPS
check negotiated `h2` and streamed events a second apart. In front of `examples/card-market`, three
runs each over HTTP/1.1 and HTTPS `h2` gave the same result: nginx passed a private page's tag to the
app and returned its `304` without a cache lookup. For a versioned stylesheet it returned
`200 MISS`, then `200 HIT`, then `304 HIT` without asking the app on the hits ([Caching](#caching)).

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

    location /assets/ {
        client_max_body_size 8m;   # more than twice the app's body limit (2 MiB); see below
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # PROXIES=127.0.0.1
        proxy_set_header Upgrade $http_upgrade;                        # WebSockets (Upgrade)
        proxy_set_header Connection $connection_upgrade;
        proxy_cache app;       # keys on Vary; stores only answers sent public
    }

    location / {
        client_max_body_size 8m;
        proxy_pass http://app;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Leave `proxy_cache` off `location /` so conditional requests for private pages reach the app:
where a location caches, nginx does not pass `If-None-Match`, `Range` or `If-Range` to the app
([proxy_set_header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)),
so a private page answers a reload with its whole body and a download cannot resume. Opt in only on
prefixes reserved for public content, such as the app's versioned files under `/assets/`.

The cost is that other public answers outside `/assets/` are not stored by nginx: Corten's runtime
and part modules under `/corten/`, the favicon, the PWA manifest, and an app's `Public` pages and
files (such as a `robots.txt`). Each still carries its `Cache-Control`, so a browser keeps it as
before. A prefix that serves only public answers can get a `location` of its own with
`proxy_cache app;`, as `/assets/` has.

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
nginx's page. It leaves `proxy_cache` off like `location /`, so a private download's `Range`
reaches the app; give a prefix `proxy_cache app;` only when everything under it is public:

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

Each `location` that passes requests to the app keeps `proxy_http_version 1.1`. Since 1.29.7 it is
nginx's default for an ordinary request, but a `proxy_http_version 1.0` inherited from an outer
block still applies, as does an older nginx's default (1.27.5's): over HTTP/1.0 the sample's
upstream connections are not kept, a `location` with `proxy_request_buffering off` still buffers
a chunked upload, and a WebSocket fails. A proxy that passes `Upgrade` on over HTTP/1.0 gets an
`Option<Upgrade>` route's other answer (its page) and an `Upgrade` route's 400, since a server
ignores `Upgrade` in an HTTP/1.0 request (RFC 9110, 7.8). Before 1.29.7 nginx also sent
`Connection: close` by default, so every `location` sets `Connection` for its connections to be
kept: the map sends none for a request without `Upgrade` (`location /` and `/assets/`), and
`proxy_set_header Connection ""` sends none at all (`/files/`, which serves no WebSocket). A
`location` that serves WebSockets keeps `Upgrade` and the mapped `Connection` on any version: the
map sends `Connection: upgrade` when the browser asks for an upgrade, and nothing otherwise.

Keep the shorter `keepalive_timeout` from row 7. Measured with the sample on nginx 1.31.9: two
separate client connections reused one connection to the app, which nginx closed after 25.1 s
idle, before the app's 30 s `App::header_timeout`. Leave `proxy_ignore_headers` without `Vary`
and `Cache-Control`.

[`examples/corten-site/deploy`](../../examples/corten-site/deploy/README.md) is a whole deploy
written out: this configuration with a certificate, limits on what one address may ask for
and hold, with what each was measured to do, a limit on the live streams one reader and all
readers may hold and, for a machine with 512 MB, the streams asked for as zstd or not
compressed at all, the app as a systemd service on one small machine, a workflow that
ships each change and puts the release before back when the new one does not answer, and a
machine that is replaced by one that serves before the address moves to it.

## Caching

A page route can answer several clients at one URL: the whole document, a client navigation
(`corten: nav`), a form's answer, and JSON for `Accept: application/json`. Only the document may be
shared, and only from a `Public` handler ([Caching](app.md#caching)); its answers say `Vary: corten,
accept, accept-encoding`, `cookie` when the request had none, and `accept-language` with
`App::messages` or on any answer that read messages in the header's language without it. A cache that keys on the URL alone hands the stored document to every request for
it. Measured on 2026-11-20 with nginx 1.31.9's `proxy_cache`: in front of `examples/card-market`,
the second document request was a `HIT`, and a navigation and a Brotli request got their own
answers. With `proxy_ignore_headers Vary`, both got the stored document (no `corten-page`, no
encoding). The example's home page does not serve JSON. With a stand-in that served both formats
and sent `Vary: Accept`, nginx fetched JSON for the JSON request by default and sent the stored
HTML with `Vary` ignored. The runtime loads a navigation answered with a document as a whole
page, so it still works, more slowly; a data client gets HTML where it asked for JSON.

The app keeps its own `Public` pages too, and its `Public` JSON, text and files of 1,024 bytes or more
([the pages the app keeps](app.md#the-pages-the-app-keeps)),
so a cache in front may be sent one the app made earlier. Such an answer carries `Age`, and a cache
that follows RFC 9111 counts its own lifetime from when the page was made rather than from when it
fetched it: a page is never shown past its lifetime because two caches each kept it for the whole
of it. With `.shared(..)` longer than `max_age`, a page older than `max_age` reaches the browser
already stale, as it does from any CDN, and the browser asks again each time; the `304` it gets
costs the app neither the render nor the compression. A purge at the cache in front does not
reach the app: the cache is sent the kept page again until its lifetime ends or a write through
the app drops it, so a page that must change at once on a purge takes a short lifetime in the app
and a long one nowhere. What is kept is held in the process's memory, 32 MiB of it unless
`App::kept_answers` says otherwise, with 256 KiB beside it once it has made an answer
it may keep and 128 KiB more once they fill it (a 256th of the bound, or up to a 128th
where that is not a power of two).
The bound counts the bytes asked of the allocator, and an allocator holds more than it is asked
for when pages come and go: the benchmark app's resident memory settled 35 MiB above where it
began with jemalloc and 58 MiB above with glibc's allocator
([design Choice 70](../design.md#choice-kept-pages)). Allow about twice the bound in the memory
the container is given.

| Cache | Pages are cached | To key on `Vary` |
|---|---|---|
| nginx `proxy_cache` | when a location has `proxy_cache` | nothing: it honors `Vary` unless `proxy_ignore_headers Vary` |
| Cloudflare | only under a Cache Rule that makes them eligible ([default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)) | the same rule's Vary setting ([Vary](https://developers.cloudflare.com/cache/concepts/vary/)): `corten`, `cookie` and `accept` passthrough (normalizing reorders `Accept`, and the app reads its first type), `accept-encoding` normalize, `accept-language` normalize with `languages` set to the app's locales (normalizing strips regions otherwise) |
| CloudFront | by its cache policy | the cache policy lists `corten`, `accept` and, with `App::messages` or a public route that reads messages without it, `accept-language` as headers and the cookies the app reads as cookies (CloudFront sends the app only the cookies its policies name), and turns on gzip and brotli ([cache key](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-the-cache-key.html)) |

A public page whose locale `Accept-Language` chooses is stored once per distinct header string
where the cache keys on it raw (CloudFront's cache key, nginx): `en-US,en;q=0.9` and `en` are two
copies of one English page, so the hit rate falls with the variety of browsers. Cloudflare's
normalizing above keeps one per locale. Elsewhere, put the locale in the page's URL (a
`Locale<Msg>` route field and `req.set_locale`, [Views](views.md#a-locale-in-the-url)): its answer
does not vary on `accept-language`, so a cache keys it on the URL and keeps one copy per locale.
A cache behavior whose pages all take their locale from the URL need not forward the header;
one that still negotiates (the `/` that sends a visitor to their locale, a 404, a page without a
locale in its URL) must, or CloudFront sends none and every visitor gets the default locale. So
must one with a public route that reads messages (`req.t()`) in an app without `App::messages`:
its answer is in the language the header asks for and says `Vary: accept-language`. Every page in
an app with `App::messages` says its locale in `Content-Language`; without it an answer names the
header in `Vary` but not the locale it chose.

The Cloudflare and CloudFront rows are from their documentation, not run here. Check a deploy
the way it was measured, on a location that caches: request a public page as a document twice and
confirm the second came from the cache (nginx's `$upstream_cache_status` is `HIT`, Cloudflare's
`cf-cache-status: HIT`, CloudFront's `x-cache: Hit from cloudfront`); without a hit the rest
proves nothing. Then request the same URL with `corten: nav`; the response must carry `corten-page`.
If the route serves JSON too, request `Accept: application/json` and check that the response is JSON.

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

## A profile-guided build

A release build can be given a profile of the app at work, which the compiler uses to lay out
and inline the code its requests run. `corten build --profile-from <command>` builds an
instrumented copy of the app, runs it while `<command>` sends it requests, and builds the
release (in `target/release`, unless Cargo's configuration puts it elsewhere) with the profile
the copy wrote.

```sh
rustup component add llvm-tools     # once: the toolchain's llvm-profdata merges the profile
corten build --profile-from sh train.sh
```

The command is the app's own, since only the app knows what its requests are. It sends the copy
requests like the ones the app will serve, at `127.0.0.1` on the port `PORT` names: each route
whose cost matters, without an `Accept-Encoding` and with each line that reaches the app from
its readers' browsers (what it has to cover, and why, is below). For an app with the one page:

```sh
#!/bin/sh
# train.sh
set -e
url="http://127.0.0.1:$PORT"
for path in /; do
    for i in $(seq 125); do
        curl -fs -o /dev/null "$url$path"
        curl -fs -o /dev/null -H 'Accept-Encoding: gzip, deflate, br, zstd' "$url$path"
        curl -fs -o /dev/null -H 'Accept-Encoding: gzip, deflate, br' "$url$path"
        curl -fs -o /dev/null -H 'Accept-Encoding: gzip, deflate' "$url$path"
    done
done
```

Cargo arguments the release needs go before `--profile-from`, and both builds get them in the
same order, so the profile is of the binary the release is:

```sh
corten build --no-default-features --features=lean --locked --bin shop --profile-from sh train.sh
```

`corten build` passes on `--features` (`-F`), `--all-features`, `--no-default-features`,
`--locked`, `--package` (`-p`) and `--bin`, with or without a profile, as they are written
(`--features=lean`, `-Flean` and an empty `--features ""` included), and refuses any other
argument before it builds. Everything after `--profile-from` is the command and its own
arguments. `--target`, `--target-dir` and `--profile` are refused, since each moves the release
from Cargo's default `target/release`, and the profiled build's copy has to run on the machine
that builds it. Corten does not check Cargo's configuration for these: a target or target
directory set there (`build.target`, `build.target-dir`) is still Cargo's to apply, and the copy
it builds has to run on this machine.

`corten build` starts the copy, and runs the command, in the directory it was started in. With
`-p` at a workspace's root, that is the root, not the member's directory, so the command's path
and the app's own relative paths are from there:
`corten build -p shop --profile-from sh shop/train.sh`. The copy gets the environment
`corten build` was given, less `HOST`, so that a copy that reads it listens on this machine
only. The build gives the copy a port, and runs the command once a connection to that port is
accepted.

That port is a free one the build picks and gives the copy in `PORT`, whatever `PORT` holds
where `corten build` runs: that one is the app's, set for running it, and is not read. An app
that binds a port of its own and never reads `PORT` (`corten::serve_on` or `serve_wrapped` with
listeners it bound itself, [Your own listeners](app.md#your-own-listeners)) never listens on a
port the build picked, so the build is told the app's with `--port`, before `--profile-from`:

```sh
corten build --port 8443 --profile-from sh train.sh
```

The copy is then looked for on that port, and it and the command are given it in `PORT`
(`--port=8443` is the same). `--port` is refused before anything is built when it is not a
number from 1 to 65535, when it is given twice or without `--profile-from`, and when something
already listens on the port, at `127.0.0.1` or at `[::1]`, which would answer the wait and the
command in the copy's place. Nothing is built then, and something is written: the build takes
its lock on the target directory before it looks at the port, so a refusal for a port something
listens on leaves `target/corten-profile/lock`, in a target directory it makes when there was
none. The build cannot tell whose listener that is, so the refusal says
what to do for each: this app (under `corten dev`, or run another way) or a copy that a
cancelled build left running is stopped, the copy of a build that is running in another target
directory is left until that build ends, and anything else is another program that holds the
port on this machine, which is stopped, or the build is run where the port is free, with
`--port` checked against the port the app binds. The build looks again before it starts the
copy, minutes later. A look is a
connection, and a listener answers one only while its queue of connections it has not accepted
has room: one that has stopped accepting, with that queue full, passes both looks as a free
port. Where it holds an address the copy binds, the build then stops after the instrumented
build, when the copy cannot bind; where it holds the other loopback address alone, the copy
binds its own and the build goes on. A
second build in the same target directory is refused for the build that is running, which is
looked for before the port, so it is not told to stop that build's copy. Without `--port`, an
app that binds its own port stops the build after a minute, with a line that names the option.

The wait is a TCP connection to `127.0.0.1` or `[::1]` at that port and nothing more. So the
port may be one that serves HTTPS, and the script then asks over `https://`, where the sample
above asks over `http://`. The app has to bind the port on a loopback address or on every
address: bound to another address alone it is not found, and the build stops after a minute
saying where it looked. The wait is for that one port: an app with several listeners names one
of them, and its script, which knows the others, waits for each before it sends to it
(`curl --retry 10 --retry-connrefused` on the first request). And the wait cannot tell whose
socket accepted: a copy that has exited is not taken for it, but a program that takes the port
in the moment between the build's last look and the copy's own bind is, and the command's
requests then go to that program. The copy cannot bind the same address then, unless both
sockets set `SO_REUSEPORT`, as two instances of one app may: the system then shares the
command's connections between the two, and the look after the copy (below) stops the build
only if the other is still listening. That is reasoned from a bind that was measured, and was
not run through a build. A copy that has
exited by the time the command ends fails the build, as one that exited while the command ran.
One that is still running when the command ends (it is still starting, or it does not exit
when it cannot bind) is stopped like any other, and may exit with a profile of having served
nothing, so with `--port` the build looks at the port twice more. When the command has ended
and before the copy is stopped, the build stops if nothing accepts a connection at either
loopback address of the port: a copy that listens on the port it was named would. After the
copy has exited, the build stops if something listens there: that is not the copy.

Each of those looks establishes one thing and no more: something accepted a connection on a
loopback address of the port when the command ended, and nothing listens there once the copy
has exited. Neither shows that the copy is what answered the command, and no look can, since a
connection does not say whose socket accepted it. Three timings end with the build succeeding
and the release built from a profile of a copy the command never reached:

1. Another program takes the named port in that moment, answers the wait and the command, and
   leaves while the command runs, and the copy, still starting or trying its bind again, binds
   the port before the command ends. The copy answers the look at the command's end, and
   nothing listens once it has exited.
2. A program listens on the other loopback address of the named port, beside a copy bound to
   its own, answers a command that asks that address (as one that asks `localhost` may), and
   leaves before the copy has exited. This needs no race with the copy's start: the program
   may come at any time after the look before the copy starts.
3. Another program takes the named port in that moment and answers the wait and the command,
   the copy is still running when the command ends, and the program leaves between the look
   at the command's end and the copy's exit.

The first two were reproduced, and the command's tests hold them as what a build does today,
to change when it can tell; the third is reasoned.

Each look can also stop a build it should not. The look at the command's end stops a build
whose copy served, when the copy's queue of connections it has not accepted is full at that
instant. The look after the copy stops a build whose profile was good when a program begins to
listen on the port once the copy has left it (a supervisor starting the app again). And a
listener on the other loopback address of the named port that is there at a look stops the
build, at the one after the copy as well, though the copy bound its own address beside it and
served for the whole run: the build cannot tell that the command never reached that listener,
and a command that asks `localhost` may have.

An app's own listeners bind the addresses the app chooses, with `HOST` or without: one that
binds every address (`0.0.0.0:8443`) can be reached from the network while the build runs, and
a request from outside would enter the profile. An app whose only listener is not a TCP port (a
Unix socket) has no port to name, and is profiled with the steps by hand (below).

When the command ends the build stops the copy with `SIGTERM` and waits for it: the copy
writes its profile as it exits, which a Corten app does on `SIGTERM` (Shutdown, in
[The app](app.md#the-app)), and a copy that is killed writes none. A command that fails stops
the build, and so does a copy that exits early, does not listen within a minute, is still
running a minute after `SIGTERM` (it is killed then), or leaves no profile; `curl -f` fails this command on an answer that is not a success, so a profile of error
pages is not taken for one of the app. The build cannot tell a command that sent the copy
nothing, or sent its requests to another port, from one that did its work: the profile is then
of the app starting and stopping, and the release is built with it all the same, without a word. Every route is then one the command left out, and a route left out cost more instructions a request than with no profile where that was measured (below); a release from a command that sent nothing was not measured. What the command sends is the part that decides the gain:
in the measurements below a profile did not have to come from the load it was measured with,
only from requests that reach the same routes, and one that barely reached them gained about
half as much.

It can decide a loss too, in the instructions a request takes: what the command leaves out is
not left as it was. On one app, a route and a coding that a command left out each cost more
instructions a request than in a build with no profile. Why is not something those counts
show; the likely reason is that the compiler lays out and inlines the code the copy ran, and
treats what the copy never ran as code that seldom runs. So the command covers what the app's
readers ask for:

1. Every route whose cost matters: each page readers reach, its JSON, a form's post. On
   card-market a command that asked for the home page and an item's JSON, and never for the
   item page, made the item page cost 4.1% more instructions a request than a build with no
   profile, and 7.2% more where its answer is in Brotli.
2. Every response coding those routes are answered in. The app picks the coding from the
   request's `Accept-Encoding` as it reaches the app, so the command asks without the header
   and with each line that reaches it. The lines the browsers Corten is tested in sent on
   Linux are `gzip, deflate, br, zstd` (Chromium and Firefox), which the starter answers in
   zstd, `gzip, deflate, br` (WebKit over HTTPS), answered in Brotli, and `gzip, deflate`
   (WebKit over plain HTTP), answered in gzip
   ([design Choice 28](../design.md#choice-fixed-stages) has the three, and
   [Choice 32](../design.md#choice-stream-coding) which WebKit sends where). Behind a proxy
   that takes the header off or rewrites it, the line that reaches the app is the proxy's, not
   a browser's ([Response compression](#response-compression)). A command that asked without
   a line and with the first, and never with the second, made Brotli answers cost 17.2% and
   9.5% more instructions a request than with no profile, on two pages it had asked for in the
   other codings.

Which coding an answer had is in its `Content-Encoding`, which curl prints with `-w`: `br`
here, and an empty line for an answer with none.

```sh
curl -s -o /dev/null -w '%header{content-encoding}\n' -H 'Accept-Encoding: gzip, deflate, br' http://127.0.0.1:3000/
```

What a command did ask for cost 3.9% to 26.7% fewer instructions a request than with no
profile, and the same within two points whichever of three commands had asked. The table is
with the measurements below. All of it is instructions, counted on one app: whether what a
command leaves out also costs more cycles or more time was not measured. Nor was a command
that leaves out gzip, or the answer with no coding, or how few requests of each are enough:
those profiles took 301 of each, and in the catalog table below a profile whose command had
asked for the page once still took 40,480 instructions a request on it against 44,786 with no
profile.

The four steps are the toolchain's own, and Corten adds nothing to the binary:

1. `cargo build --release` with `-Cprofile-generate`, into a target directory of its own under
   `target/corten-profile`. So `target/release` never holds a binary that writes a profile, and a
   step that fails leaves the last release as it was. The copy is kept: the next profiled build
   compiles only what changed in it. A build that makes more than one binary is refused
   here, since a profile is of one program: `--bin` names the one. Apps that share a target directory (a workspace's)
   share `target/corten-profile` too, so a profiled build is refused while another runs there.
2. The copy, run with `LLVM_PROFILE_FILE` naming a directory of this run's own, after what
   earlier runs left is removed. The macros and build scripts that ran during the first build
   were built the same way and wrote profiles too, and a profile left from an earlier run
   would be merged with this one.
3. `llvm-profdata merge`, with the tool from the toolchain's `llvm-tools` component, which
   reads what its rustc writes; one on the `PATH` may be another LLVM's. A toolchain without
   the component is refused before the first build, with the `rustup` line above.
4. `cargo build --release` with `-Cprofile-use`. Every crate compiles again, since the flag
   changed, and again whenever a new profile replaces the file. Cargo keeps an ordinary
   build's crates beside these, so a `corten build` afterwards with the same Cargo arguments and
   no `--profile-from` can reuse an ordinary build already made, if nothing has changed since,
   and puts the binary without the profile back in the release directory.

The two flags reach Cargo in the environment, after any `RUSTFLAGS` already there. Cargo takes
its flags from the environment or from its configuration, never both, so flags that a
`.cargo/config.toml` sets (`build.rustflags`, a `target.<..>.rustflags`: a linker, a CPU) would
be left out of both builds without a word. The command refuses that before it builds, naming
the file or variable: give it the flags the build needs in `RUSTFLAGS`, and both builds keep
them. It reads those files as text, not as Cargo does, so it also refuses one that sets flags
for another target or includes another file; an empty `RUSTFLAGS` says the build wants none.

The option needs a Unix system, since it stops the copy with a signal; on Windows it is refused
before it builds, and a Linux container builds the release the Dockerfile's way. That
Dockerfile, as `corten new` writes it, builds its own binary in the image, so a binary built
here is not the one the image runs: the image's build runs this same command when it is given
the script ([A profile in the image](#a-profile-in-the-image)). A `corten build` that is itself stopped by a signal
(a cancelled job, `timeout`) leaves the copy running, as `corten dev` leaves the app. For a
build the option refuses or does not cover (Windows, a cross build, a Cargo argument not on
its list), the same steps by hand are in the rustc book's
[profile-guided optimization](https://doc.rust-lang.org/rustc/profile-guided-optimization.html).

Measured on the lean catalog app (`bench/catalog/corten`) at `7685c7f24` with rustc 1.99.1 in
`rust:1-bookworm`, on a desktop under Docker with other work running. That app is not the
starter's: built with `--no-default-features` (no `compress`) and one codegen unit, run with
`PROFILE=catalog-lean` (no deadline or timeouts), on glibc's allocator. Five builds that differ
only in the profile served the same catalog page load and answered the same bytes: the app on
one CPU, `wrk` with 64 connections on three others in the same container. Cycles are user and
kernel together, a request, by `perf stat` on the app's process, over 12 rounds in which the
builds took turns in the same order; instructions are one connection under callgrind (1,300
requests less 300), one run a build. These five were built with the toolchain's steps by hand,
before `corten build` had the option.

| Profile taken from | Cycles a request, median | Range | Instructions a request |
|---|---|---|---|
| none | 132,337 | 124,688 to 161,670 | 44,786 |
| the measured load itself (15 seconds of it) | 99,755 | 86,659 to 115,794 | 37,207 |
| the same page, 3,000 requests each on a new connection, asking for `text/html` and accepting a browser's codings | 98,882 | 86,496 to 114,087 | 36,621 |
| a mix: that page, its JSON, the home page and a 404, 1,000 of each | 96,738 | 88,814 to 103,948 | 36,283 |
| the JSON API, 3,000 requests, after the one page request that waits for the app to start | 114,522 | 103,714 to 125,277 | 40,480 |

Each profiled build took fewer cycles than the build without one in all 12 rounds: by the
medians a quarter fewer for the first three (25%, 25% and 27%) and 13% fewer for the profile of
the JSON API, which had rendered one page. Paired by round against the profile of the measured
load itself, the page asked another way was 918 cycles higher at the median and lower in 5 of
the 12 rounds (single rounds from 9,892 lower to 7,132 higher), and the mix 5,727 lower and
lower in 7 (11,965 lower to 16,117 higher): these rounds do not tell either from it. So on this
app and this load a profile did not have to come from the load it was measured with, only from
requests that reach the same route; a profile that barely reached it gained about half as much.

The option itself, measured at `b032155e2` with the same rustc, container and load: the catalog
app with its default features (`compress` on), built by `corten build` and by
`corten build --profile-from` with a command that asked for the catalog page 3,000 times, each
on a new connection, accepting a browser's codings. Over 10 rounds in which the two builds took
turns:

| Load | `corten build`, cycles a request, median (range) | With `--profile-from` | Difference in the same round, median | Rounds it was lower |
|---|---|---|---|---|
| the catalog page, accepting no coding | 143,443 (132,553 to 152,283) | 105,464 (98,222 to 123,785) | 30,730 fewer, 21% of the ordinary build's median | 10 of 10 |
| the same page, accepting a browser's codings, so each answer is compressed | 230,402 (208,981 to 242,264) | 192,597 (174,045 to 237,618) | 32,516 fewer, 14% | 8 of 10 |

Ten rounds of each load an hour and a half earlier, with the machine busier and a binary the
option built from the sources of `70544a54a` (the same two builds; what changed since is how
the copy is started and stopped and what is refused), gave 45,676 fewer on the page (29%:
107,713 against 155,368) and 50,251 fewer with each answer compressed (18%: 233,162 against
286,487), lower in all 10 rounds of each. So on this app the option took 21% to 29% of the
cycles off the page and 14% to 18% where each answer is compressed, and two runs on one desktop
do not place it closer than that.

From an empty target directory the ordinary build took about four minutes and the profiled one
about eleven, the 3,000 requests included: one build each, on the busier machine. Two later
profiled builds that had nothing to compile in the instrumented copy took about five minutes
and, with the machine quieter, about two and a half. The binaries are 6,154,312 bytes and
5,869,496, the merged profile 2.8 MB, and the target directory about 250 MB after the ordinary
build against about 580 MB with the instrumented copy beside the release.

The app `corten new` writes, measured at `9fae8ff55` from binaries its Dockerfile's commands
built in its build image, run on its run image and not from an image `docker build` made: built in `rust:1-trixie` (rustc 1.100.0) with the starter's release profile and
`compress`, by the Dockerfile's `cargo build --release --locked` and by
`corten build --locked --profile-from sh train.sh` in its place, with the script above as it
then was (500 requests for the home page, each with `Accept-Encoding: gzip, deflate, br, zstd`
and none with another line or without one); run on `debian:trixie-slim` with jemalloc preloaded and the
image's settings at that commit (a 64 KiB thread cache), as root, the two binaries in one container with `perf` and `wrk`. The home
page is 1,274 bytes, and 649 in zstd, which the app chose from a browser's codings. The app on
one CPU, `wrk` with 64 connections on three others, 10 rounds in which the two builds took
turns, on a desktop with other work running; medians are the sixth of the ten:

| Load | Ordinary build, cycles a request, median (range) | With the profile | Difference in the same round, median (quartiles) | Rounds it was lower |
|---|---|---|---|---|
| the home page, accepting no coding | 130,903 (116,483 to 144,262) | 84,456 (75,017 to 94,579) | 41,922 fewer, 32% of the ordinary build's median (39,009 to 51,108 fewer) | 10 of 10 |
| the same page, accepting a browser's codings, so each answer is compressed | 183,102 (170,580 to 206,422) | 139,061 (132,722 to 170,062) | 40,193 fewer, 22% (37,519 to 47,111 fewer) | 10 of 10 |

On the first load, by the medians, user cycles a request fell from 70,915 to 34,876 and the
kernel's from 59,988 to 49,595, user instructions from 27,905 to 19,929, L1 instruction-cache
misses from 4,232 to 1,966 and branch misses from 275 to 141. What the image's build costs for
it is in [A profile in the image](#a-profile-in-the-image).

What a command leaves out, measured on card-market (`examples/card-market`) at `be1192a7b` with
rustc 1.100.0 in `rust:1-trixie`, on a Xeon Platinum 8280: the workspace's release profile, zstd
linked to the image's `libzstd` as the example's Dockerfile sets it, and one item, read from the
smoke fixture. Four builds at the workspace's root: `corten build --locked -p card-market`, and
the same with `--profile-from` and three commands. The first asked for the home page and the
item page, each with no `Accept-Encoding`, with Chromium's and Firefox's (answered in zstd) and
with WebKit's over HTTPS (answered in Brotli), and for the item's JSON. The second asked for the
same without the item page, and the third for the same as the first without the two Brotli
lines. Each line was 301 requests by curl: 300, five on a connection, and one more whose coding
the script printed. Instructions a request are
callgrind's, the server on one CPU with jemalloc preloaded, the image's thread cache and no
background thread (`background_thread:false`, which the image has on): one
keep-alive connection sending what curl sends, 1,240 requests less 240, over 1,000, the median
of three counts, which differed by at most 69 instructions. The four builds answered each
request with the same status, coding, type and length. Each profiled build is given against
the build with no profile:

| Request | No profile | All seven of these requests | Without the item page | Without Brotli |
|---|---|---|---|---|
| the item page, no coding | 77,800 | 65,421 (-15.9%) | 80,967 (+4.1%) | 64,477 (-17.1%) |
| the item page in zstd | 348,251 | 334,610 (-3.9%) | 350,013 (+0.5%) | 333,601 (-4.2%) |
| the item page in Brotli | 844,544 | 770,959 (-8.7%) | 905,245 (+7.2%) | 989,576 (+17.2%) |
| the home page, no coding | 32,384 | 24,259 (-25.1%) | 23,737 (-26.7%) | 23,982 (-25.9%) |
| the home page in zstd | 116,034 | 106,533 (-8.2%) | 105,757 (-8.9%) | 106,151 (-8.5%) |
| the home page in Brotli | 230,893 | 197,244 (-14.6%) | 194,153 (-15.9%) | 252,889 (+9.5%) |
| the item's JSON, no coding | 65,729 | 56,860 (-13.5%) | 56,580 (-13.9%) | 56,641 (-13.8%) |

Each profile was then taken again and each profiled release built again from it, three other
binaries: no count moved by more than 0.2%, and no percentage by more than a tenth of a point.
So the route a command left out cost more than with no profile at all, and so did the coding
another left out, on pages that command had asked for in the other codings. zstd moved least:
with the first command the zstd rows took 13,641 and 9,501 fewer instructions than with no
profile, about what the rows with no coding did (12,379 and 8,125). An explanation, not a
measurement: zstd is the system's library in these builds, which a profile of the app does not
reach, and Brotli is compiled with the app. These are instructions, the work a request takes,
not cycles or time, on one app, and gzip was in no command and no count. The scripts and their
output are commit `30206df73`, kept under the tag `evidence/profile-coverage`.

Not measured: another app or page in cycles, what a command left out in cycles or time, a profile taken from an earlier version of the app
or with another rustc, and a profile used on another kind of CPU than it was taken on. Nor the
time a reader waits: no latency was kept, and the pages a second the same
rounds counted (64 connections against one CPU) say little, 17,567 at the median without a
profile (11,578 to 18,678), 21,504, 21,228 and 22,610 with the first three and 17,727 with the
JSON API's, whose cycles were 13% lower.

## Response compression

The starter enables `compress`. A response compressed per request is zstd for a client that
offers it; for one that does not, gzip up to 16 KiB and Brotli past it, or the one of the two
the client accepts. Assets and held JSON compressed once are Brotli and gzip, and event streams
zstd or gzip, never Brotli ([Choice 32](../design.md#choice-stream-coding)). A request's gzip
is made by libdeflate: up to 16 KiB it was smaller than Brotli at level 1, the level a request's
Brotli is made at, on all but one of the bodies measured and took less to make (29% fewer
cycles a request under load for JSON of 4 to 8 KB), and at every size it was
smaller than the gzip it replaced ([Choice 78](../design.md#choice-request-gzip)). So one
client can be sent gzip for a short page and Brotli for a long one; `Vary: Accept-Encoding`
is the same for both.

Revisit Brotli when a zstd/gzip-only build can serve supported clients without a slowdown.
For a body compressed per request that was measured: past 16 KiB a body that repeats was up
to 30% larger as gzip and one that does not at most 7.4% smaller, so Brotli stays there. For assets and held JSON, compare release
builds on the same runtime, kit CSS and held JSON, and try high-level zstd where the client
offers it. Measure bytes for both client groups and browser load time on a throttled link if
the replacement sends more. A faster encoder on the server is not enough if the extra bytes
make the page slower for the visitor.

`libdeflate-sys` builds its bundled C sources and links them into the app, so the build needs
a C compiler, which the starter's build image has, and the runtime image nothing for it.
By default `zstd-sys` builds its bundled C sources, which needs a C compiler, even when a
system zstd is installed. The starter's Dockerfile instead sets `ZSTD_SYS_USE_PKG_CONFIG=1` to use the build image's libzstd, which needs
`libzstd.so.1` in the runtime image. To keep compression in an image without that shared
library, remove the setting so the build compiles zstd and links it into the app. With the
setting, libdeflate is the only C the starter's image compiles. To build
without either C library, turn off the `compress` feature in the app's `Cargo.toml`.

Whichever compresses, the proxy passes the browser's `Accept-Encoding` on to the app (row 13
above). With the feature or without, a page `GET` is hashed for an `ETag` only when the request
accepts a coding or already names a tag ([design Limit 21](../design.md#limit-etag)), and what
counts is the header as it reaches the app. Behind a proxy that takes it off, a browser that holds
no tag is never sent one, and so gets the whole page each time where it would get a `304`. With
the feature on and the header passed, the app compresses and the proxy has nothing left to do; to
have the proxy compress instead, build without the feature and still pass the header. A proxy
takes it off when it is told to (nginx's `proxy_set_header Accept-Encoding ""`), and one that
compresses for the app may be set to: HAProxy's `compression offload` takes it off each request
that accepts a coding HAProxy is set to use, as a browser's does.

The tag is half of it: for a page the proxy does not answer from a store of its own, the `304`
needs the browser's `If-None-Match` to reach the app too. nginx takes it off in a `location`
that has `proxy_cache`, which is why the [configuration above](#nginx) leaves `proxy_cache` off
`/`. In a `location` that has it, nginx answers a tag itself for a page it stored. Passing the
header on by hand beside `proxy_cache` (`proxy_set_header If-None-Match $http_if_none_match`)
is not the way to have both: nginx then stored a public page's `304` and gave it to the next
reader, who held no page, and with `proxy_no_cache` on the header to stop that, a request that
names a tag never refreshes the stored copy. The nginx behavior was rechecked on 2026-11-20
with nginx 1.31.9 in front of `examples/card-market` and a stand-in server that printed the
headers it received. The HAProxy behavior was checked with HAProxy 3.0.31 in front of a stand-in,
not a Corten app. What Cloudflare and CloudFront do with the two headers was not checked.

To check both, pick a page that carries an `ETag` when asked straight from the app with the
`Accept-Encoding` below (one whose layout takes `req.nonce()`, that draws a `SubmitKey::field`,
or that is `no_store`, never does) and that the proxy does not store, and send the proxy the two
requests a browser would. Send `GET`s: `curl -I` sends a `HEAD`, which
the app tags whatever it accepts, and which nginx asks the app for as a `GET` in a `location`
with `proxy_cache`.

```sh
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip, deflate, br, zstd' https://shop.example/account
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'If-None-Match: W/"<the tag>"' https://shop.example/account
```

The first must show the `ETag`, and the second `304`. The [configuration above](#nginx) leaves
both headers on for a page under `/`, and its check saw a private page's tag reach the app and
the `304` come back; with `/account` in a `location` that has `proxy_cache`, the second shows
`200` and the page again, the whole body [that section](#nginx) describes. A page nginx stores
does not test the second header, since nginx answers its `304` from the store; it still needs
the first, without which the copy it stores has no tag to match.

## Building the image

The Dockerfile uses Debian 13 (trixie) in both stages: `rust:1-trixie` builds the app and
`debian:trixie-slim` runs it. It builds with `cargo build --release --locked`, as `corten check`
holds its Cargo steps to the lock. `corten new` writes `Cargo.lock` with the app; run `cargo build` or
`corten dev` after a dependency change and commit `Cargo.lock` before checking or building the
image. A missing or stale lock fails rather than resolving crate versions the check did not
test. For a workspace app, include the workspace-root manifest and lockfile in the Docker build
context, along with the members it needs.

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

### A profile in the image

The image's build takes a profile of the app at work when it is given the app's script:

```sh
docker build --build-arg PROFILE_FROM=train.sh -t shop .
```

`PROFILE_FROM` is the script's path from the app's directory. The build then runs
`corten build --locked --profile-from sh -- train.sh` where it would run
`cargo build --release --locked`: a copy of the app runs in the build stage while the script
sends it requests, and the image gets the binary built with what the copy recorded
([A profile-guided build](#a-profile-guided-build) has the script, the steps and what stops
them). Without the argument the build runs what it ran before and fetches nothing more. A path
that is no file fails the build before it builds the app. That is all the build checks of it: a
path that leads out of the app runs the file it finds, as the build's user, which is root, like
the app's own build scripts.

An app whose Dockerfile was written before it had the argument takes the `ARG` and the two
build-stage `RUN`s from a new app's. Without them the argument is read by nothing and the image
is the ordinary one: Docker 29.9.3 built it without a word about the argument.

The two builds are two lines of one `RUN`. A Cargo argument the app's release needs
(`--features`, `--bin`) goes on both, before `--profile-from` on the second: on one alone,
the image with a profile is built with other features than the image without. An app that
binds a port of its own names it on the second, with `--port 8443` before `--profile-from`
([A profile-guided build](#a-profile-guided-build)). The `corten` the Dockerfile installs has
to be a release that has `--port`. One without it builds nothing with the line: where the
Dockerfile's own check of the command (below) has not refused it first, it refuses `--port`
as an argument `corten build` does not take, before it builds the app. The fix is to move the
version on the Dockerfile's install line to a release that has `--port`: 0.3.0 is the first. An
older release refusing `--port` in an image build has not been tried.

What the argument asks of the app and its build, which the ordinary build does not:

- The app starts with what a build has. `docker build` runs no other container beside it, so
  an app that connects to a database or another service as it starts exits, or does not listen,
  and the build fails saying which. Such an app's image keeps the ordinary build:
  `corten build --profile-from` builds a profiled binary where those services are, and putting
  that binary in an image is not something this Dockerfile does. A secret given as a build
  argument is kept in the build's record, so an app that needs one to start is not given it
  that way.
- The script's tools are in the build stage. `rust:1-trixie` has `curl`; anything else the
  script runs is installed there first. A script checked out with Windows line endings fails
  in `sh`.
- The `corten` command and the toolchain's `llvm-tools` are fetched in the build, in a `RUN` of
  their own before the sources are copied in, so a builder that has kept that layer does not
  fetch them again after a change to the app. The command is the release with the number
  `corten new` wrote the Dockerfile with
  (`cargo install corten-cli --version <that release> --locked --root /usr/local`), built from
  source into the layer: cargo's home in this build is a cache, which is no part of a layer.
  When the app moves to another Corten release, change the version on that line with it. A
  release without the option is refused there, before the app is built. 0.2.0 is one: its
  `corten build` took no arguments and would build the ordinary binary without a word. A
  `corten` built from a commit between releases writes the number of the release before it,
  so its Dockerfile installs that release's command, not the commit's, and is refused this way
  only when that release lacks the option (a command built before 0.3.0 wrote 0.2.0).
- `llvm-tools` is added to the build image's toolchain. An app with a `rust-toolchain.toml`
  builds with its own, and `corten build` refuses a toolchain without the component, naming
  it; that file's `components` is where rustup takes it from. Not tried in an image build.
- The build takes longer, and the app's target cache holds the instrumented copy beside the
  release. The starter's own image at `f909c0d2d`, its install line pointed at that checkout
  since no release had the option then, so the 45 seconds are not an install from crates.io;
  one build each on a desktop with a lint run beside it:
  69 seconds the ordinary way, and 188 with `PROFILE_FROM` in the same target cache
  afterwards, of which 45 fetched `llvm-tools` and built the `corten` command and 138 were the
  build step (63 the ordinary way), the script's 500 requests included. A build with
  `PROFILE_FROM` after a change to one file, at `99c6ccc85`, took 121 seconds, with the first `RUN` reused: a
  new profile compiles every crate again, where the ordinary build compiles the app's own.

The gain measured on the starter's own app is with the other measurements in
[A profile-guided build](#a-profile-guided-build): 32% fewer cycles a request on its home page,
and 22% fewer where each answer is compressed, from binaries these two commands built in this
build image, run on the run stage's image.

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

## Access logs

Access logging is off, also in the app `corten new` writes. Set `App::access_log(true)` to get
one `INFO` event with target `corten::access` for each response through the app's tracing
subscriber, including refused hosts, cross-site writes and conditional `304`s. The path has no
query; bytes describe the final body after compression (or `"stream"` for an unknown size), and
duration ends when the response is ready, not when its body finishes sending. The line costs
each request: measured, a small parameter route's instructions grow by about half ([Access
logs](app.md#access-logs) has the numbers). See
[Access logs](app.md#access-logs). Keep the proxy's logs for requests it answers without calling
the app; when they are enough, leave the switch off. An app's own middleware is not an access
logger: it cannot see the host check, a later error page or a `304`.

## Benchmark Hosts

In the [full-stack browser group](../../bench/fullstack-browser/LIFECYCLE.md#script-disabled-full-document-journeys),
ordinary no-JS document navigation can prove that the old realm was destroyed. This is a
functional evidence path, not a timing comparison. Parser assets and blocked script preloads
remain in the report, and the dead realm's unavailable resource counts are not reported as zero.

Before allocating a benchmark host, use the **Benchmark Evidence** workflow on
the merged source. If its replay checks passed but the push skipped native Linux,
run the workflow on `main` with `native_only=true`. Otherwise a manual run
with the default inputs runs the whole evidence suite. Verify the run's commit
and the successful jobs before counting them. Neither mode starts a droplet or
produces framework timings.

Before reserving a new grouped fleet, its [placement preflight](../../bench/workloads/CLOUD.md#dedicated-group-hosts)
checks the provider's size and region listings for all required hosts. The
reservation fixes those locations; create never tries a different region.

New guest reservations use the [pinned upstream Git verifier](../../bench/workloads/CLOUD.md#public-source-permissions)
before checkout, without relying on Launchpad. A failed verification or Git
capability check is a setup failure, not benchmark evidence.

For a partial round, the [independent group procedure](../../bench/workloads/CLOUD.md#independent-group-continuation)
replays completed results from their original evidence and reserves only the
named missing group. Different groups in the same continuation can measure on
separate droplets once each earlier host is supervised. Allocation is serialized;
terminal collection is independent. Each group keeps its own measured commit,
date and hardware.

The grouped benchmark's [disposable-host preparation](../../bench/workloads/CLOUD.md#evidence-and-cleanup)
holds firmware-update services outside the measurement boundary before baseline.
On a fresh dedicated group host it also limits incoming SSH to the controller's
authenticated provisioning IPv4 source. Keep that egress for collection and
cleanup; do not make a separate login during measurement.
Its cleanup check retains all process observations and exempts only kernel threads
proved by saved Linux stat flags and matching PID/start identity. An authenticated monitored
or offline-handoff campaign can
[take one additional cleanup observation](../../bench/workloads/isolated/CAMPAIGN.md#post-command-udev-settle)
after official timing or untimed JSON preparation, once the last native command's sealed
lifetime verifies termination and an empty accounting scope, and every new user-space identity
is a proved udev worker, including where the daemon and workers share the distribution's
`/usr/bin/udevadm` executable. Timing requires worker birth strictly after the sealed terminal cutoff;
untimed JSON preparation uses its pre-phase census cutoff instead. The bounded wait, worker exit
and ordinary whole-host boundary checks must all pass. Replay uses the measured checkout: this
cannot qualify old evidence that lacks the proof or discount activity during measurement.
This is benchmark-host preparation, not app deployment advice.

A new benchmark allocation launched from a commit that includes
[pinned unused-host recovery](../../bench/workloads/CLOUD.md#failed-allocation-retirement)
can use it after interrupted pre-start file uploads only from the same measured checkout,
once the original local process tree and all registered remote sessions and watchers have
drained. The result is retirement evidence, not a benchmark result.

When collecting a completed group, allow up to 15 minutes for each local replay of
the saved evidence. A timed-out or cancelled replay does not qualify the results.
After a timeout, a completed monitored child with a saved archive can use the
[sealed archive retry](../../bench/workloads/CLOUD.md#api) at the
original measured commit, allowing up to 45 minutes per replay without rerunning
the group.
The replay time is not part of any framework's timing.

To build the Git-capable browser test image manually, run `npm ci` from the repository
root and pass the image that matches the installed Playwright version, as CI does:

```sh
version=$(node -p 'require("@playwright/test/package.json").version') &&
  docker build --build-arg PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v${version}-noble" \
    -f bench/workloads/test-tools.Dockerfile -t corten-evidence-tools .
```

The Dockerfile has no default base image. CI builds Git 2.56.1 from its
[upstream release on kernel.org](https://www.kernel.org/pub/software/scm/git/), not from
the Launchpad PPA or the runner's installation. It verifies the pinned archive SHA-256
and the detached signature on the uncompressed tar from Junio Hamano's pinned release key.
When updating Git, verify both, and update the source pin and final image version check
together. The compiler and source stay in the build stage. The final image checks that
a missing blob in a local partial clone cannot be fetched with `--no-lazy-fetch`, but
can be fetched without it. This check needs neither a network nor a Docker socket.
