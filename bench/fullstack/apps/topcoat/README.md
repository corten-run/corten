# Native marketplace alerts

Marketplace pages, routes, form decoding and templates remain Topcoat's native
ones. An accepted POST validates with the existing ICU locale formatter, then
appends one `{item_id,email,target_minor}` record. Topcoat's origin policy still
runs before form/body and source work. Rejected input and missing records/locales
do not append. The read-only page and record JSON handlers do not access the store.

`GET /api/alerts` is a native `#[route]` returning `Json<Vec<Alert>>` in insertion
order with `Cache-Control: no-store`. It does not fetch a marketplace record,
create a cookie, clear the list or extend its expiry. Every browser/session needs
its own cookie jar for this independent readback.

On the first accepted write Topcoat's native session `Token` generates 32 secure
random bytes. Only its SHA-256 `TokenHash` is held as the store key. Topcoat's native
cookie parser/writer carries the base64 credential as host-only
`marketplace_session`, `Path=/`, `HttpOnly`, `SameSite=Lax`, no browser expiry.
The listener is HTTP; trusted deployment configuration
`MARKETPLACE_PUBLIC_ORIGIN=https://...` sets `Secure`. Forwarding headers do not
choose it. Topcoat's native origin policy remains authoritative. An unknown token
never chooses a new session's identity. No global cookie/session middleware was
added to the existing read-only paths.

The mutex-protected, process-local ordered lists expire one hour after session
creation and are lost on restart. Limits are 4,096 live sessions and 1,024 alerts
per session; exhausted storage returns native 503, without evicting live lists.
This stores synthetic benchmark alerts, not durable or distributed user data.
No dependencies were added.

```sh
cargo test --locked
cargo fmt --check
```

The native-image HTTP/browser driver in `../gin/check-alerts.mjs` accepts `topcoat`
and an image name. It checks both fixture/API sources, JS/no-JS native forms,
same-cookie-jar readback, locale validation, isolation and concurrent writes.
It is test-only, not a shared application backend or a performance measurement.
