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
- Additional matched-profile catalog browser gates **failed in both sources** at `bench/catalog/check.mjs:182`: inline-style CSP violations with unchanged htmx loaded. No CSP, markup or gate was relaxed. This remains a combined-image integration check, not a qualified result; runtime causation was not established.
- The temporary Razor harness first probed nonexistent `/health`; that attempt failed before gates. It was corrected to the existing `/health/ready` for matched mode. Both attempt logs were retained.
- Shared gate unit tests: 47/48 passed; the LiveView pre-fill readiness diagnostic test timed out in its own initial navigation at 500 ms. An unchanged focused rerun passed 1/1. The original suite is not reported as fully green.

Local ignored receipts are under `apps/aspnet-aot/tests/results/runtime-refresh/`:
native-project logs, Razor gate results/raw responses, official metadata snapshots,
the temporary harness text and the separate native-live patch. Native AOT's checker
also retains `apps/aspnet-aot/tests/results/review-native-raw.ndjson`.
These are development validation, not an official benchmark round or reusable
combined-image provenance. No throughput, CPU or memory comparison was measured.
Root-wide checks and independent review remain with parent integration.

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
