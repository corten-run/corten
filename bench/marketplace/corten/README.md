# Native alert persistence

The existing native `POST /marketplace/{locale}/{id}` now appends one accepted
alert to an in-memory, process-local store. This is enabled in both default and
matched profiles, with either record source; no parity flag is required. Locale
parsing and localized validation still use Corten's native form and money APIs.

`GET /api/alerts` independently reads that store as an insertion-ordered JSON array:
`[{"item_id":"item_1","email":"buyer@example.test","target_minor":1250}]`.
It returns `Cache-Control: no-store`. No cookie, an unknown cookie, or a fresh
browser context reads `[]`; reads never create, clear or reset state. Invalid
forms, missing records, unsupported locales and cross-site rejections never append.
Each accepted POST appends once, including a repeated accepted form. There is no
retry deduplication key or reset/debug endpoint.

The first accepted POST issues `marketplace-alerts`, a host-only, HttpOnly,
SameSite=Lax session cookie. Its server-generated random token alone binds later
POSTs and independent GETs to the same store; caller-chosen unknown tokens are
replaced, never registered. Preserve the response cookie before sending more
writes, including concurrent writes. Two first POSTs sent without a cookie are
separate sessions. Page and record-JSON GETs do not initialize alert sessions.

Corten's cookie helper defaults to Secure. An accepted form with a same-origin
`http://` Origin uses its explicit local-HTTP option so all benchmark browsers,
including WebKit, retain the cookie. An HTTP client with a cookie jar should send
the matching Origin too; without one the cookie keeps Secure. HTTPS forms keep Secure. Use HTTPS for real
user data; these benchmarks use synthetic data. Sessions and rows live until the
process exits; this is not durable storage or a multi-instance session service.
Appends and read snapshots are atomic under a mutex, never held across an await.
No framework dependency or shared framework change is needed.

Focused checks from the repository root:

```sh
cargo test --manifest-path bench/marketplace/corten/Cargo.toml
```
