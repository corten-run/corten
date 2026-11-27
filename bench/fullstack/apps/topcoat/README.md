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
`MARKETPLACE_PUBLIC_ORIGIN=https://...` sets `Secure` on that public authority only,
not on the separate direct HTTP preflight. Forwarding headers do not
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

## Matched profile parity

The matched profile's existing 10-second request deadline still returns 503
and drops the in-flight handler and upstream read. The deadline response now
has a short `text/plain` body. This addresses the missing Content-Type in Mixed
Production r69, where the upstream reads were already cancelled.

The r65 Marketplace checks exposed separate gaps. In the matched profile,
missing or failed record JSON reads and a wrong method on the record endpoint
return Problem Details. The router still decides which methods are allowed.
An upstream error on the page returns HTML with the existing 500 status.
`GET /health/live` answers without reading the record source.

The matched profile accepts only the loopback host names (`localhost`,
`127.0.0.1`, `[::1]`) and exact host names listed in `HOSTS` (comma-separated,
without ports). Requests may include a port. An unknown Host such as r65's
`unrecognized.invalid` receives 421 before the adapter reads the source.
Forwarded host headers do not affect this check. The native same-origin
check for writes and the default profile are unchanged.

Matched Marketplace pages use `script-src 'self'`. They keep the same
Topcoat runtime and readiness modules. Their links and filter/alert forms
are ordinary HTML, with no client expression, event directive or shard that
needs the runtime's `new Function` compiler. Other routes keep the previous
policy: the native item page uses those features and Topcoat 0.12.1 cannot run
them under a no-eval CSP without an upstream compiler or runtime change.

Neither r65 source is requalified by these changes. The r65 deadline, body/header
limits and connection cap that were not probed are not diagnosed here.
See the [recorded qualification outcomes](https://github.com/corten-run/corten/issues/1305#issuecomment-7147850444).

On a Linux build runner, from this app directory with the pinned Topcoat CLI:

```sh
cargo build --release --locked
topcoat asset bundle --release
node tests/check-parity.mjs target/release/item-page-topcoat
# With the repository's Playwright and Chromium installed:
node tests/check-parity.mjs target/release/item-page-topcoat --browser
```

The browser probe checks the native runtime and readiness scripts, filter and
offer navigation, and alert POST and readback with and without JavaScript on
each source, without bypassing CSP. In Catalog Contract's Topcoat parity job,
after the Marketplace check-only build and Playwright image setup, one
`check-parity.mjs <binary> --browser` invocation runs the HTTP and Chromium probes for
both matched sources. It takes the release server and its sibling assets from
`cb-marketplace-topcoat` and runs them with Chromium in the workflow's Playwright
image, on isolated loopback. Fixture probes must make no upstream requests;
API browser navigations must read the controlled upstream. This is a focused
parity check, not the full Marketplace qualification or a timed run.

The probe uses the actual bundled binary and a loopback record source. It
checks both source modes, error representations and liveness, plus the real
deadline and one upstream cancellation in each API locale. It does not qualify
the app for load or replace the shared browser and hardening checks.

## Alert write handling

Alert writes reject malformed record identities and ratings. The existing native
page resolves its full view and preflights native HTML materialization before
committing; it still returns a Topcoat view, retaining native page/frame delivery.
Read-only paths are unchanged. This does not promise rollback after later network
failure or change native abort semantics. Exact minor-unit tests cover values above
2^53, i64 maximum/overflow and ICU's magnitude limit with long leading-zero input.

## Request-local source traces

Marketplace page GETs, native alert POSTs and record JSON reads capture an owned
trace snapshot from Topcoat's `request::original_headers(cx)`. The source takes
that snapshot explicitly, including when work is delayed. Only a single valid
W3C `traceparent` is forwarded; future versions retain their known fields as
version 00 with only the sampled bit, per
[W3C Trace Context 3.2.4](https://www.w3.org/TR/2021/REC-trace-context-1-20211123/#versioning-of-traceparent).
Existing version-00 flag transport is unchanged. Missing, malformed, duplicate
or zero-id parents do not propagate a parent or `tracestate`.

With a valid parent, `tracestate` retains its HTTP field bytes, including 8-bit
obs-text, without CR/LF. Multiple state fields are combined as an HTTP list. The
shared native reqwest client has no request-specific default headers. Fixture
reads remain in memory and never send HTTP. Router, native rendering, JSON
serialization, form handling, deadlines and production profiles are unchanged.

```sh
cargo test --release --locked
cargo fmt --check
docker build -t topcoat-trace .
node check-trace.mjs topcoat-trace
```

The last command checks the actual production image with a controlled upstream:
both profiles and sources, all three page locales, JSON and accepted alert POSTs,
unchanged traced/untraced response bodies, independent alert readback, 8-bit
state bytes, invalid/duplicate parents, delayed source responses and a form body
held while newer traced and untraced requests finish. A native router unit test
also delays work after capture but before the outbound source request, then
checks that it sends its original trace after newer requests complete.

`node check-trace-flags.mjs IMAGE` checks the normal release image in both
profiles and both sources: JSON GET/HEAD, page GETs and native alert POSTs in all
three locales, exact traced/untraced body bytes, future flags `80/81/fe/ff`,
unchanged v00 flags, malformed parents, obs-text state and raw NUL/control/DEL
headers. `repeated-state` as a second argument checks ordered native combination
of repeated state fields. Image identity, body lengths/hashes and source
observations remain under `results/trace-proof/row7-*.ndjson`; temporary fixtures
and containers are removed. These are correctness regressions, not native-audit,
qualification or performance results.

Historical source-lane Row7 evidence (2026-11-13, not release-head verification):
the author fetched upstream `8b02835d6987150ce8bc3d6a48c9e700fa81c27a`
without merging it into the local source lane. The new release-mode unit test failed
before the runtime fix with actual flags `80` versus expected `00`; after the fix,
`cargo test --release --locked` passes all 13 tests, including delayed native
capture and the new regression. `cargo fmt --check` also passes.

The normal optimized image reproduced 64 source-header failures before
(`row7-flags-1794549171107.ndjson`). After the fix,
`row7-flags-1794549890759.ndjson` passes all 524 checks: 512 route/header cases
and 12 hostile-control probes. `row7-repeated-state-1794549890654.ndjson` passes
all 96 ordered repeated-state cases. Every compared response body is byte-equal.
The existing `check-trace.mjs` also passes both profiles and sources, including
delayed/concurrent reads and native alert readback. No validation was weakened.

Image identity and raw observations are retained alongside older evidence. The
image was built from a local working context, not a clean retained archive. No
instruction/timing comparison, browser matrix, full Corten framework checks or
independent review was run for this repair. Shared guide/changelog edits and
another agent are outside the authorized scope. This does not confer native-audit
or mixed-production admission.
