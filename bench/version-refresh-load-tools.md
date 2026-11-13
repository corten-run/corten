# Load-tool refresh

Source read: unpublished grouped integration atop fetched origin/main
`f12d3daa324644c1fc882a5d994408d774cbb58e`. Scope is load tooling only, for
[#1380 bench/fullstack runs its load with grafana/k6:latest and records no image, while catalog, marketplace and json-api pin one digest, so its rounds cannot say which k6 measured them](https://github.com/corten-run/corten/issues/1380),
including its triage comment, read through the GitHub REST API on 2026-11-13.

## Selected release

The official [Grafana k6 v2.4.0 release](https://github.com/grafana/k6/releases/tag/v2.4.0)
was published 2026-11-12 at 13:27:33 UTC, with `draft=false`, `prerelease=false`.
This selects the current production release deliberately, not the older 1.x line or
the floating Docker `latest` tag. The release's experimental features are not enabled.

Official [Docker Hub tag metadata](https://hub.docker.com/v2/repositories/grafana/k6/tags/2.4.0)
and `docker buildx imagetools inspect grafana/k6:2.4.0` identify:

- Release index: `sha256:d41bb79cd8de5a7ad619b53570e3712633e8bff0937010a5c6c57a4747e7a276`.
- Selected linux/amd64 manifest: `sha256:70949facc324f13a8903d24ee5b817ff32aca02bda3458389611e6aa4b38a097`.
- Resolved image ID, measured locally: `sha256:6d08a99453a19788507ace498410a0a78ec1c00a6e710bb1b23cf49c4a9c084a`.
- Actual executable output, measured locally: `k6 v2.4.0 (commit/dd9395906d, go1.27.3, linux/amd64)`.
- Actual RepoDigests includes `grafana/k6@sha256:70949facc324f13a8903d24ee5b817ff32aca02bda3458389611e6aa4b38a097`.

The shared `bench/load-tool.mjs` pins the platform manifest. A release tag is never
used to run a measurement. Its probe records the executable output, parsed version,
image ID, RepoDigests and platform, and refuses a different executable version or platform.
This is an amd64 campaign input, not an arm64 benchmark qualification.

## Evidence and compatibility

Catalog and marketplace record the probe in `summary.tools.k6`; catalog also writes
the identical record to its existing raw `tools.json`. Legacy fullstack writes
`tools.json` before its first load and carries it into `summary.json`, including
when reading a packed raw archive. Its A/B script keeps the existing row-array
summary shape and records the tool alongside it, rather than changing consumers.
Count, SSR, warmups and A/B all use the shared pin; unattended cleanup follows that
pin rather than `latest`. No cleanup command was run against another task's resources.

Legacy continuation requires the same pin, image ID, version, platform and version
output. Existing measurements with no tool record are refused, not assigned today's
identity. Pulling another alias of the same image does not invalidate continuation.
Existing saved rounds and their bytes are not rewritten. The old `3e4186ae...`
image's executable version has not been established here, so this is not a measured
speed delta from that image or from an earlier floating-tag fullstack round.

Marketplace's existing comparison already treats the resolved k6 image ID as an
input. Integration with the newer marketplace raw validator remains a separate
requirement. JSON API records the actual probe and strictly replays every retained
provenance field before qualifying a measurement. Fullstack's trend report refuses
a baseline-to-current range containing mixed or missing tool identity once any
round records it. Catalog's native saved-evidence v2 also requires that provenance;
v1 files are preserved but cannot qualify as newly verified v2 evidence.
Entirely historical unknown-tool ranges keep their original
behavior, not a retroactively verified identity. An explicitly accepted later
baseline can begin a new compatible range; this change does not move baselines.

## Checks

- Pure provenance and legacy continuation tests pass with
  `node --test bench/load-tool.test.mjs bench/fullstack/load-tool.test.mjs`.
- With `K6_IMAGE_CHECK=1`, `node --test bench/load-tool.test.mjs` passed all four tests,
  including actual image probes of `ab-load.js`, `ssr-load.js`, catalog, marketplace
  and JSON API load scripts. Each sent a one-second, one-user closed-loop workload
  to a synthetic local HTTP server; every exported summary passed `readLoad`, and
  the flattened metrics required by fullstack were present. Probe containers used
  `--rm` and ownership labels; temporary output was deleted.
- Focused legacy round/SSR/pass checks, catalog runner/contract/output/raw checks,
  JSON API contract/report checks and marketplace run-contract/report/split checks:
  151 tests, 150 passed, one Windows SIGHUP test skipped, zero failures. These include
  stats/parser checks. The new legacy metadata suite also passes all four tests,
  including actual summarize/pack/re-summarize propagation and historical absence.
- `git diff --check` passes. No floating k6 image reference remains in fullstack
  executable `.mjs` files (a no-match `rg` exit is expected).

No framework code, dependencies, CI, defaults, equivalent-work gates, saved results,
cloud services or full benchmark runs were changed/run. No performance or full
qualification claim follows from unit fixtures or these short tool probes. Full
CONTRIBUTING Rust/browser checks and independent review belong to parent integration,
not this bounded tooling slice. Root changelog/guide edits are intentionally left
to the parent to avoid concurrent ownership.
