# .NET 11 Runtime Refresh

Provisional row 7 evidence, checked 2026-11-13. This is a runtime-only handoff,
not group admission, a performance measurement, or permission to reuse old images.

## Sources

Read `origin/main` at `4966977c8b8a7a367c0ed9087e1ae4e0b938f288` after fetching.
Read the exact REST body and all paginated comments of
[#1393 bench/fullstack builds on .NET 10, Java 25, Ruby 3.4, PHP 8.4, Python 3.14, Elixir 1.19/OTP 28 and Node 24 while each runtime's newest stable is a line ahead](https://github.com/corten-run/corten/issues/1393).
There was one comment. Independently fetched official metadata before changing pins:

- [Microsoft release index](https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json): newest stable channel 11.0, runtime 11.0.0, SDK 11.0.100, released 2026-11-10; STS, not the older LTS channel.
- [.NET 11 release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/11.0/releases.json): stable release/runtime 11.0.0 and SDK 11.0.100.
- [NuGet version index](https://api.nuget.org/v3-flatcontainer/microsoft.aspnetcore.mvc.testing/index.json) and [listed package metadata](https://api.nuget.org/v3/registration5-semver1/microsoft.aspnetcore.mvc.testing/11.0.0.json): stable Microsoft.AspNetCore.Mvc.Testing 11.0.0. Its catalog entry targets net11.0.
- MCR manifest requests for each exact tag below returned HTTP 200. Production builds resolved the same digests.

| MCR image | Resolved manifest digest |
|---|---|
| `mcr.microsoft.com/dotnet/sdk:11.0.100` | `sha256:65f3c7c6a25a239ab3e6719f2896147e7b68242ff2d8818dd70498bde6ef8bea` |
| `mcr.microsoft.com/dotnet/aspnet:11.0.0` | `sha256:bc0d6653979efba491ab3d6f589d691f96c309c3c3ef81325efa6978e7b7f242` |
| `mcr.microsoft.com/dotnet/runtime-deps:11.0.0` | `sha256:6d3e208d8f5ba599ad9e80c615b5c1a2e355fd903f585cb07342dde29441675a` |

SDK `dotnet --info`: SDK 11.0.100, MSBuild 18.12.2-1.26529.118,
host/runtime 11.0.0, commit `297acf930f`, Ubuntu 26.04, linux-x64.
The Razor production image independently reports Microsoft.AspNetCore.App and
Microsoft.NETCore.App 11.0.0, with no SDK installed.

## Scope And Identity

Both fullstack apps and both test projects target net11.0. Razor's matching
Mvc.Testing package is 11.0.0. MessageFormat, other test packages, htmx 2.0.11,
Razor rendering, source generators, PublishAot, globalization settings, workers,
entrypoints, request limits and application behavior are unchanged. The htmx lane
owns its asset refresh. Shared build recipes, framework code, CI and changelog
integration are outside this patch.

The tracked app directory Git tree IDs after the refresh are:

- `apps/aspnet`: `b19919a90e2882ebca953c95e29e4c63e6dd217b`.
- `apps/aspnet-aot`: `1dfaf09ec662f02fa210b243f84d8ab07ad7105e`.

Actual production image IDs, built from each app's normal Dockerfile with `--pull`:

- Razor: `sha256:8c33ac70c1f62f78a10ec41e1e69a4eb7dc7ef944c7e2d3a9e796e4575e48635`.
- Native AOT: `sha256:dc184cba01e23a22bbac22a46587ca1ba5f3887a55eea010b857e96424d7c500`.

The AOT build executed native code generation and published linux-x64 Release.
Its final image starts `/app/ItemJson`, contains no ItemJson.dll or installed
dotnet runtime, and its executable starts with ELF bytes `7f 45 4c 46`.
`ldd` resolves only libm, libc and the ELF loader, not CoreCLR.
Executable SHA-256: `3510777e6bfb0e9dad42d33f14a9b0eb917d6c9f9ba26bd700a37a4b9f4cafa0`.

## Checks And Limits

- Both normal production Docker builds passed without application compatibility edits.
- `dotnet test .../aspnet/tests/Marketplace.Tests.csproj -c Release` on SDK 11.0.100: 15 passed, zero failed/skipped.
- `dotnet run --project .../aspnet-aot/tests/Records.Tests.csproj -c Release`: all source/model/serialization checks passed with reflection disabled, including 165 invalid-schema cases.
- `node bench/fullstack/apps/aspnet-aot/tests/check-native.mjs IMAGE` against the actual native AOT production image passed: both sources and both full 500-record workloads, shared JSON gates, 187 invalid HTTP schemas, seven invalid fixture startups, legacy routes, health, method handling, cancellation and recovery.
- Measured native AOT request deadlines were 10026/10029 ms for catalog headers/body and 10032/10007 ms for marketplace headers/body. Corresponding caller-disconnect checks completed in 47/85 ms and 41/80 ms. Each observed one upstream read and zero remaining active upstream work; these are functional lifetime checks, not performance comparisons.
- Existing shared JSON gates against the Razor production image passed catalog-v1 and marketplace-v2 in both sources: all 500 records each, fixture zero reads, API one fresh read per request, reserialization, missing records and upstream errors/redirect handling.
- Existing catalog browser gate in the catalog runner's default native profile passed both sources: 500 JSON records, 120 page checks and eight browser profiles per source, plus API freshness/error checks.
- Existing marketplace browser gate in matched profile passed both sources: 500 JSON records, 264 page checks and 12 browser profiles per source, including native forms and API freshness/error checks.
- Initial additional matched-profile catalog browser gates **failed in both sources** at `bench/catalog/check.mjs:182`: inline-style CSP violations with unchanged htmx loaded. The follow-up below isolates the cause; this runtime-only image remains failing, not qualified.
- The temporary Razor harness first probed nonexistent `/health`; that attempt failed before gates. It was corrected to the existing `/health/ready` for matched mode. Both attempt logs were retained.
- Shared gate unit tests: 47/48 passed. The first failure was `LiveView pre-fill readiness retains the intended case and original failure` (`bench/marketplace/check.test.mjs:107`), duration 7611.8363 ms: `page.goto: Timeout 500ms exceeded`, navigating to `http://localhost/marketplace/fr-FR/item_1`, waiting until `load`, at line 113. The test sets its default timeout to 500 ms at line 110. This failed before the intended `alertReady` diagnostic assertion at line 114, not inside the ASP.NET app. An unchanged focused rerun passed 1/1 (test 9544.3363 ms, total 13275.4206 ms). It does not establish why the first navigation timed out, erase that failure, or make the original 47/48 suite green. No shared test was changed.

Local ignored receipts are under `apps/aspnet-aot/tests/results/runtime-refresh/`:
native-project logs, Razor gate results/raw responses, official metadata snapshots,
the temporary harness text and the separate native-live patch. Native AOT's checker
also retains `apps/aspnet-aot/tests/results/review-native-raw.ndjson`.
These are development validation, not an official benchmark round or reusable
combined-image provenance. No throughput, CPU or memory comparison was measured.
Root-wide checks and independent review remain with parent integration.

## Matched Catalog CSP Follow-up

Fresh reproduction against the original .NET 11 production image failed in both
fixture and API sources: `desktop-light`, JavaScript enabled, expected browser/
resource errors `[]`, actual 15 identical inline-style CSP errors per source at
`bench/catalog/check.mjs:182`. The blocked style hash was
`sha256-faU7yAF8NxuMTNEwVmBz+VcYeIoBQ2EMHW3WaVxCvnk=`. Both attempts and the
final nonzero assertion are retained in `csp-old-both-sources.log` and
`razor-csp-old-matched-gates.json`; the checks were not filtered or weakened.

The smallest control used the same native .NET 11 production page at
`/catalog/record_1`, unchanged strict CSP and a fresh Chromium context per case:

| Browser-side diagnostic variation | CSP events | Console errors |
|---|---:|---:|
| Original native response, htmx 2.0.11 | 1 | 1 |
| Same response, only `includeIndicatorStyles:false` meta inserted | 0 | 0 |
| Same response, only verified htmx 4.0.1 asset substituted | 0 | 0 |

The event was `style-src-elem`, blocked URI `inline`, source
`/htmx.min.6dpfg1qi0s.js:1`. Its injected CSS was exactly:

```css
.htmx-indicator{opacity:0;visibility: hidden} .htmx-request .htmx-indicator, .htmx-request.htmx-indicator{opacity:1;visibility: visible;transition: opacity 200ms ease-in}
```

Hashing that text yields the blocked hash above. These are diagnostic response/
asset substitutions, not production qualifications. No meta configuration was
added to the app. `csp-control.json` retains all three cases and identical policies.

The old base and .NET 11 branch have identical `Program.cs` blob
`1f476cddbd9365794889306baf5136126c7c2d46` and layout blob
`a22579d36843b71664f886b4be194debfb2d5082`; all pages and browser scripts are
unchanged. The original image's htmx asset SHA-256 is
`d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717`,
the old base's exact Docker pin. The fullstack README's matched-tier ASP.NET
description already records this indicator-style CSP violation from the old
application. Together with the controlled reproduction, this identifies the
preexisting htmx injection as the cause, not a .NET 11 compatibility regression.
No .NET 10 binary was built or executed; this is not a cross-runtime binary A/B.

The htmx owner was contacted before considering any markup change. Published
[htmx 4.0.1 source](https://unpkg.com/htmx.org@4.0.1/dist/htmx.js) uses
`CSSStyleSheet.replaceSync` and `document.adoptedStyleSheets` for indicators,
instead of an inline style element. Its minified asset SHA-256 independently
matched the owner's pin:
`a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130`.
No extra app workaround, CSP relaxation, htmx asset edit or markup edit is part
of this .NET branch.

A separate ignored production build context combines runtime commit
`166b5437a35ca4b288f83aeac22277ac01bab1ce` with only the ASP.NET asset delta
from `57764546bcc860aad36de48ca8245ca393306020` and the inherited-boost layout
from `90aa7e2885d82a35cd0a28ede7c8813b38fc32a5`. Its layout is exactly the
owner's blob `c079a5291f94f6e8987bc3fac1acb6b2f5b7dc2a`. The normal production
Dockerfile built successfully using SDK 11.0.100 and ASP.NET 11.0.0 at the same
MCR digests above; no old runtime was built. Control image:
`sha256:354441ea169b84cbe5e18a6f43a4aa6d9eead7fbd2218b3171b5e33fd3fae31f`.
It reports both runtime frameworks 11.0.0. Published `ItemPage.dll` SHA-256:
`6e682c3e481959a30b63dda5bdd64f4ff8bb15a2a9f5d13b3a42fff760c2d959`.
The local per-file source SHA-256 manifest is `combined-source-sha256.json`
(SHA-256 `5891d1399181bc0a52a2f5a78d1ee050d18349bfb1fedfb7c6cd55b610cfec5c`).
Build output is retained in `combined-build.log`.

The actual combined production image passed all eight unmodified existing-gate
invocations, exit 0: both JSON payloads, catalog browser and marketplace browser,
each in fixture and API mode. Each JSON payload checked all 500 records per
source. Catalog checked 500 records, 120 pages and eight browser profiles per
source; marketplace checked 500 records, 264 pages and 12 browser profiles per
source. API freshness, single reads, reserialization and upstream error checks
also passed. Catalog's normal console/resource assertion now reports no CSP
failure in either source; no errors were suppressed. Results and raw JSON are
retained in `razor-htmx4-matched-gates.json`, `combined-gates.log` and the
`razor-htmx4-*-raw.ndjson` receipts. The exact temporary harness is retained as
`combined-gate-driver.mjs.txt`; diagnostic scripts are retained as text alongside
their results. The copied build context was removed after retaining its per-file
manifest and exact two-file patches (`combined-dockerfile.patch`,
`combined-layout.patch`).

The runtime-only htmx 2 image is still red in matched catalog mode. The CSP
blocker is resolved by the separately owned htmx 4 migration in this combined
control, not by a change to .NET or by relaxing the fair contract. Parent must
merge both lanes and take fresh provenance from its final composed source.
This local production control is not official grouped-run admission or a
performance result. The previously verified native AOT image and separate
native-live pin patch are unchanged.

A separate browser probe against that native combined image confirmed catalog
related navigation sent `HX-Request: true` and `HX-Boosted: true` without a document
navigation and retained a per-document marker. Marketplace "show all" instead
performed a full document navigation without either htmx header, preserving its
native boost-disabled policy. There were zero console/page errors. Evidence:
`boost-control.json` and `boost-control.log`. The first optional probe targeted
the matrix runner's fixture container after it had been removed and got
`net::ERR_CONNECTION_REFUSED`; the successful probe used its own dedicated
container. This harness race is not an application result.

## Separate Native Live Patch

The native-live pin refresh is separate commit
`24258f52e6aa4a874264e8d31363be0e28786e2f`, exactly one commit above parent
`ff99dc292cd6b16acca56797ac431e9a77cb369e`. Apply that single commit or its
one-commit format-patch, not the parent branch's unrelated history.
Only `bench/live/apps/aspnet/Dockerfile` and `LiveParity.csproj` change:
SDK 11.0.100, ASP.NET 11.0.0, target net11.0. Program.cs remains blob
`0b1a2d8564411d5c56213e58f78a590fdbc47fc1` from the parent.

An isolated SDK 11.0.100 Release publish passed. Its generated runtimeconfig
requires net11.0, Microsoft.NETCore.App 11.0.0 and Microsoft.AspNetCore.App 11.0.0.
No native-live production image was built or qualified in this lane.
Parent validation must freshly build the native port and run both existing
live-delivery and recoverable-live browser/fault suites with `--apps aspnet --build`,
then independently verify saved artifacts. Retain the emitted runtime version,
source hashes and new image ID. A passing subset is not complete group admission;
old .NET 10 live images and their captures do not qualify this patch.
