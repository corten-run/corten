# Deploying behind a proxy or CDN

[Back to the guides](../../README.md#documentation)

Corten speaks HTTP/1.1. HTTP/2 or HTTP/3 to browsers and a shared cache come from a proxy or a CDN
in front of `corten::serve` (design.md, Limits 14), which usually ends TLS too (the app can,
[`serve_wrapped`](app.md#your-own-listeners)). This page is what that proxy has to do
for a Corten app, the nginx configuration it was checked with, and the settings for two CDNs.

## What the proxy must do

| | What | Why |
|---|---|---|
| 1 | pass the browser's `Host` as it came, port included, and list the names in `HOSTS` | the app answers `421` to a name it does not know ([Host names](app.md#host-names)); a write or a WebSocket handshake without `Sec-Fetch-Site` (Chromium and Firefox sent none on one here) is checked by comparing its `Origin` with `Host`, so with any other `Host` the app's own pages cannot open a WebSocket (measured: 403 with nginx's `$host`, which drops the port) unless `Policy::allow_origin` names the public origin; nginx's `proxy_pass` sends the upstream's name (`app:8080`) unless told otherwise |
| 2 | set `X-Forwarded-For`, and list the proxy's addresses in `PROXIES` | otherwise every request comes from the proxy ([The client's address](app.md#the-clients-address)) |
| 3 | serve browsers HTTP/2 or HTTP/3 | each open live stream holds a connection, and over HTTP/1.1 a browser has about six per host ([Connection](live-data.md#connection)) |
| 4 | pass event streams on as they are written | a buffered stream arrives late or not at all (below) |
| 5 | key a shared cache on `Vary` | one URL answers a document, a navigation and JSON ([Caching](#caching)) |
| 6 | let the app's 4xx and 5xx bodies through | they are the app's error pages and redrawn forms (nginx's `proxy_intercept_errors` is off by default; [Requests and forms](requests-and-forms.md)) |
| 7 | reuse a connection to the app for less time than `App::header_timeout` | the app closes an idle connection after it (30 seconds), and a request the proxy sends on it as it closes fails; nginx 1.29.7 and later reuse upstream connections by default, for 60 seconds, so set `keepalive_timeout` in the `upstream` block (below) |
| 8 | expect a connection to the app per open stream | streams multiplexed over one HTTP/2 connection to the proxy still each hold an HTTP/1.1 connection to the app, so `App::max_connections`, if set, counts them |
| 9 | check `/health/live` and `/health/ready` | both answer to an IP address or `localhost` as the host, so a health check needs no name; `/health/ready` answers within 800 ms (`App::ready_within`), so a probe timeout of one second or more reads its answer ([Health](app.md#health)) |
| 10 | allow request bodies as large as the app's largest form | nginx refuses a body over `client_max_body_size` (1 MB) with a page of its own, before the app can answer it in the form |
| 11 | keep a quiet WebSocket open, or let the app ping it | nginx closes a proxied connection that sends nothing for `proxy_read_timeout` (60 seconds), a WebSocket included; Corten's `Upgrade` sends no pings of its own, so a socket that may go quiet longer pings from the app or gets a longer timeout in its `location` |

### Live streams

`<corten-live>`, feeds and `corten::event_stream` answer `text/event-stream` with
`X-Accel-Buffering: no`, which tells nginx not to buffer that response whatever `proxy_buffering`
says, and write a keep-alive comment on a quiet stream every 15 seconds, under nginx's 60-second
`proxy_read_timeout`. Measured with `examples/watchlist`'s `/live/trades` (an event a second)
through nginx 1.27: without the header, nginx's default there (HTTP/1.0 to the app,
`proxy_buffering on`) and `gzip on` for `text/event-stream` each sent no byte in 25 seconds; with it, every case
delivered events 1,000 ms apart, as the app wrote them, compressed or not. A CDN must not cache a
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
        client_max_body_size 8m;   # the app's largest upload, plus its form
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

`keepalive` needs `proxy_http_version 1.1` and a `Connection` header other than `close`, which
the map gives a request that is not a WebSocket. Leave `proxy_ignore_headers` without `Vary`
and `Cache-Control`.

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
