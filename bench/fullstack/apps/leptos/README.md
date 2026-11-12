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
existing 404/502 outcomes. These repairs do not establish full production parity,
upstream cancellation qualification or a new performance result.

```sh
cargo test --locked --features ssr --test marketplace_post --test marketplace_json
```
