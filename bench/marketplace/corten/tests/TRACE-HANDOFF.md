# Native marketplace trace checkpoint

This follows `0ac7568c9` separately, against the immutable-operation contract in
`235ffd5:bench/mixed-production/REVIEW-CONTRACT.md`. Upstream read this turn was
`2406278965a9cc7761018764a03d1a6824d8d860`; its scoped app files did not overlap.
Only the Corten marketplace and ASP.NET/Express apps and scoped tests/docs change.

## Native propagation

- Corten extracts an owned, request-local optional header before the form/body
  extractor. Page, JSON and POST handlers pass it explicitly to Source.record.
- ASP.NET page/JSON handlers pass a captured string to MarketplaceSource.Get.
  Each HttpRequestMessage owns its header; shared HttpClient defaults and native
  Activity/configuration remain untouched.
- Express page/form middleware captures the primitive header before body parsing;
  JSON captures it on handler entry. The existing source fetch takes it as an
  optional argument. Catalog/item clients receive no propagation change.

The validators follow [W3C Trace Context](https://www.w3.org/TR/trace-context/#versioning-of-traceparent)'s known fields: lowercase hex, separators,
nonzero trace/span IDs, no ff version or duplicate field. Version 00 is forwarded
unchanged. Valid known fields of a future version are down-versioned to 00 rather
than interpreting or forwarding its unknown suffix. Invalid input does not add an
application header. There is no ambient mutable current-operation state, exporter,
new dependency, extra fetch, record parser, fixture behavior or configuration change.

ASP.NET's unchanged native Activity stack can start a fresh trace when an incoming
context is missing/invalid. The negative probes explicitly allow that native
behavior but reject invalid output or reuse of any issued incoming operation ID.
This is not a claim that ASP.NET sends no header for untraced requests.

## Observed checks

`traceparent.mjs` ran actual immutable native image IDs on one CPU/1 GiB, default
and matched profiles, all three page/form locales and record JSON. It passed 14/14
groups per app, with 74 source requests completed and zero pending/cancelled per
app. Each discovery and POST source operation fetched exactly once; independent
alert readbacks fetched nothing. Discovery, primary POST and readback contexts
were distinct. Receipts include image labels, dirty-source input hashes, fixture
and driver hashes, and actual per-operation source traceparent/path/lifecycle:

- `results/final-trace-corten-1794536849121/summary.json`
- `results/final-trace-aspnet-1794536690946/summary.json`
- `results/final-selfcontained-trace-express-1794536790124/summary.json`

These builds identify `0ac7568c9` plus their recorded dirty input manifests, not a
clean measured-source audit. This handoff file was added after the runs. Runtime
source files were compared again to those input hashes before committing.

Overlapping page/JSON requests held source headers or a partial native JSON body
until a different context completed. The held native response could not complete
before release. A genuine native form, including Razor's captured antiforgery
field/cookie, was kept unfinished until another context completed; only then did
its original-context source read start. Accepted POSTs were independently read
back with exact item/email/minor-price state. Invalid cases include malformed
syntax, uppercase, zero IDs, ff, extra v00 fields, wrong separators and duplicates,
each followed by another untraced request. Future-version known-field propagation
and a final valid context were also checked. ASP.NET's 36 negative/untraced source
requests had fresh native trace IDs; Corten/Express's had no traceparent.

Focused suites passed: Corten 9 tests and scoped rustfmt check, ASP.NET 15 tests,
Express 9 tests (seven native regressions and two trace tests). Each source also
has a direct delayed-start check: an explicitly captured call starts after a
different-context call completes. Actual native production images used their
existing Dockerfiles. No full framework checks or mixed workload matrix ran.

The first Express trace-driver run failed because its cleanup released a held
response twice, not because native propagation failed. Its raw failure remains
in `results/after-trace-express-1794536141772/summary.json`. The driver release was
made idempotent and subsequent final runs passed. No failed artifact was relabelled.

## Remaining gates

`LIFETIME-HANDOFF.md` is unchanged. In particular, the original Corten 57/58 socket
abort failure at the unchanged 500 ms bound remains UNRESOLVED, as do the retained
earlier ASP.NET lifecycle failures. This propagation work neither repairs nor
requalifies them. No lifetime timers, cancellation readers, CSRF, proxy trust,
Host policy, money/forms, storage or native error contracts were weakened.

Fresh independent source review and mixed admission remain parent/integration
work. These traces are scoped functional evidence, not an independent native
audit receipt, calibration, complete parity claim or measured-group admission.
No child, cloud action, publishing or shared runner/proxy edit occurred. Temporary
native images, containers and processes are removed; the branch/worktree and raw
receipts remain for the separate review checkpoint.
