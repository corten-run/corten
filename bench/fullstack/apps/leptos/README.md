# Native marketplace fallback

The plain marketplace POST fallback uses the existing Leptos route, resource and
native form extraction. Cross-site requests are rejected before reading their body
or fetching a record. Enhanced server-function handling remains native.

The listener serves HTTP. A deployment behind TLS termination must explicitly set
`MARKETPLACE_PUBLIC_ORIGIN` to its public HTTP(S) origin, including a non-default
port when applicable. Credentials, paths other than `/`, queries and fragments are
not allowed. This trusted origin permits a proxy to rewrite Host; forwarding
headers and absolute request URLs do not choose the trusted scheme. Without the
setting, comparison uses HTTP and the request Host. Invalid settings reject
Origin-bearing requests. Native forms without Origin remain permitted when Fetch
Metadata is absent. When Sec-Fetch-Site is present, only `same-origin` and `none`
are accepted; `same-site`, `cross-site`, invalid or duplicate values are rejected.
The current HTTP-only runner needs no setting change.

Marketplace JSON retains native serialization and JSON representations of its
existing 404/502 outcomes. Unsupported methods on `/api/marketplace/{id}` return
405 with problem JSON and Axum's `Allow` for GET and HEAD.

In `PROFILE=matched`, `HOSTS` is a comma-separated list of HTTP hostnames or IP
addresses. A host entry without a port allows any valid port; an entry with a port
allows only that port. `localhost`, `127.0.0.1` and `[::1]` default to any port
only when that host has no explicit entry. For example, `HOSTS=localhost:8443`
does not allow `Host: localhost` or `Host: localhost:8444`. Equivalent IPv6
spellings identify the same host, so `[0:0:0:0:0:0:0:1]:8443` also restricts
`[::1]` to port 8443.
Unknown hosts are rejected, and forwarding headers do not choose the host.
Deployments that rewrite Host must allow the authority seen by Leptos. Set
`MARKETPLACE_PUBLIC_ORIGIN` separately for browser form origin checks as above.
`GET /health/live` reports that the process is serving HTTP, independently of the
marketplace source. It is not a readiness check.

Catalog Contract runs the focused native check against its `cb-marketplace-leptos`
image in matched mode with a mounted fixture and with a separate HTTP upstream.
To repeat it with that image already built:

```sh
node bench/fullstack/apps/leptos/check-marketplace-production.mjs cb-marketplace-leptos
```

This check covers the three HTTP cells, not full production qualification, other
workload groups, or performance.

```sh
cargo test --locked --features ssr --test marketplace_post --test marketplace_json
```

## Session alerts

Both the plain POST fallback and the hydrated Leptos `ServerAction` append one
alert after the same locale/email validation. The resource loader is read-only:
fallback rendering receives an already loaded record and result in request-scoped
Leptos context, so rendering or hydration cannot replay a write. The enhanced form
uses Leptos's `FromFormData` and server-function transport; without JavaScript its
ordinary form still posts to the page. The existing origin check is retained
before body/source work and also guards `/api/marketplace-alert` before native
server-function argument decoding. Rejected input, missing records and unsupported
locales never append.

`GET /api/alerts` independently returns Axum's native JSON array of
`{item_id,email,target_minor}` in insertion order, with `Cache-Control: no-store`.
It does not call a resource/server function, fetch an item, issue a cookie, clear
rows, or refresh expiry. Use the same browser/session cookie jar as the form.

The first accepted write mints 32 OS-random bytes, hex encoded in host-only
`marketplace_session`, `Path=/`, `HttpOnly`, `SameSite=Lax`, no browser expiry.
`Secure` is set when trusted `MARKETPLACE_PUBLIC_ORIGIN` starts with `https://`,
not from the request URL or forwarding headers. The listener is HTTP. Unknown
credentials are replaced, not adopted. The standard `cookie` parser/writer and
`getrandom` OS-entropy API are new direct server-only dependencies because Axum
provides neither; no new client dependencies or common backend are introduced.

The mutex-protected process-local store expires sessions one hour after creation,
and restart loses them. Limits are 4,096 live sessions and 1,024 alerts per session;
exhausted storage refuses a write without evicting live rows. The plain handler
returns 503 and the server function returns its native error. This is synthetic
benchmark persistence, not durable or distributed storage.

`cargo test --locked --features ssr` includes cookie, capacity, expiry and
concurrent-append unit checks. The native-image driver documented in
`../gin/README.md`, with `leptos`, exercises fixture/API sources, native enhanced
and no-JS forms, independent same-cookie-jar readbacks and multi-client isolation.

Writes reject malformed upstream records, identity mismatches and invalid ratings.
The plain fallback materializes the native Axum/Leptos HTML body successfully
before committing. The enhanced server function commits after validating its
record and preparing its typed success result, not by rendering a second page.
Neither operation promises rollback after a later network failure or extends the
native upstream/client-abort semantics. Read-only handlers are unchanged. Exact
minor-unit tests cover values above 2^53, i64 maximum/overflow and ICU's decimal
magnitude limit, including long leading-zero inputs.
