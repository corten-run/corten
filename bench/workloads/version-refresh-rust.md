# Rust benchmark version refresh

Checked 2026-11-13 against crates.io, upstream release/source tags and Docker Hub.
This is a new-round comparison input, not a rewrite or requalification of any
saved round. Keep previous results, image identities and version receipts intact.
No contender/group membership, native wire format, alert store, tracing policy,
validator or production feature gate changes belong to this dependency refresh.

## Selected inputs

| Input | Before | Selected | Evidence and reason |
|---|---|---|---|
| Topcoat and CLI | 0.11.0 | 0.12.1 | [crate registry](https://crates.io/api/v1/crates/topcoat), [CLI registry](https://crates.io/api/v1/crates/topcoat-cli), [release](https://github.com/tokio-rs/topcoat/releases/tag/v0.12.1): newest non-yanked stable, published November 10; Rust minimum 1.99. Keep native routing, templates, runtime, assets, sessions, SSE and Tower adapter. |
| cargo-leptos | 0.3.11 installer | 0.3.12, locked crates.io install | [registry](https://crates.io/api/v1/crates/cargo-leptos), [source tag](https://github.com/leptos-rs/cargo-leptos/tree/v0.3.12): newest stable, published November 9; Rust minimum 1.82.0. No GitHub release installer was available for this version when checked, so do not manufacture a download URL. |
| reqwest | 0.12.28 in catalog/marketplace Corten, Leptos and Topcoat; 0.13.5 in axum + Maud | =0.13.5 in all five manifests | [registry](https://crates.io/api/v1/crates/reqwest), [release](https://github.com/seanmonstar/reqwest/releases/tag/v0.13.5): current stable major and patch, Rust minimum 1.85.0. Retain `default-features = false`, `json`, and Leptos's server-only optional dependency. Existing upstreams use HTTP, not a newly enabled TLS backend. |
| Rust build image | floating rust:1-bookworm | rust:1.100.0-trixie | [Rust release](https://github.com/rust-lang/rust/releases/tag/1.100.0), [Docker Hub tag](https://hub.docker.com/v2/repositories/library/rust/tags/1.100.0-trixie): current stable compiler, satisfies Topcoat 1.99 minimum; same exact build input for all seven assigned Dockerfiles, including the later live Corten Dockerfile-only extension. |
| Runtime image | debian:bookworm-slim | debian:trixie-20261104-slim | [Docker Hub tag](https://hub.docker.com/v2/repositories/library/debian/tags/trixie-20261104-slim), [Debian support](https://www.debian.org/releases/trixie/): Debian 13 regular security support to August 9, 2028. Build/runtime distributions move together, avoiding a newer-glibc build on an older runtime. |

The pinned multi-platform image digests are:

```text
rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31
debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
```

Docker Hub's corresponding linux/amd64 manifest digests are
`sha256:ebc54bef33ec8f9a5cd05799366010f35efbb73b354fb4f2cb086ec6b9460ef5`
and `sha256:7378260c0a098d27ac206225db5e7d92b8c7c84ea7afccc86eeb513756bbd392`.
The round must still record its actual built application images and resolved OS
packages. Debian packages installed by the Corten Dockerfiles are not snapshot
pinned. Compiler, glibc, OS packages, CLI output/runtime assets and reqwest's
dependency graph are changed compatibility inputs; no historical speed delta
is implied. No allocator is added or changed in application source here.
Bookworm's regular Debian security coverage ended July 11, 2026, but its
[LTS window](https://www.debian.org/releases/bookworm/) continues to June 30,
2028. The selection is a coherent move to the current regular-support window,
not a claim that all bookworm security support has ended.
Topcoat 0.12's native link prefetch defaults and destination-script fallback are
also upstream behavior inputs; this migration neither replaces nor disables them.

Already current and retained in the fullstack locks: axum 0.8.9, Maud 0.27.0,
Leptos 0.8.23, leptos_axum 0.8.10, leptos_meta 0.8.7 and leptos_router 0.8.17
(their individual crates.io `max_stable_version` values checked on the same date).
No unrelated lockfile-wide update is intended. reqwest updates are targeted;
Topcoat's companion crates move with its required minor release.
The resolved Topcoat default graph removes its unused mail/lettre branch and
adds asset grammar/macros and metadata crates. No app feature is disabled to
obtain that change; the app retains Topcoat's upstream defaults plus `sse,tower`.

## Integration boundaries

Authored from the requested `6d8272036d68e5c9a8a8af7bb0c2698094cd12fd`.
Upstream rules were also read at `f12d3daa3`; a main-checkout fast-forward was
refused because preexisting local edits would be overwritten, and none were
stashed or reverted. The exact REST issue bodies and all comments were read with
paginated requests for
[#1378 The image corten new writes, every example and the Rust bench apps run on Debian 12, which left Debian's regular security support on 2026-07-11](https://github.com/corten-run/corten/issues/1378)
and
[#1384 bench/fullstack's apps are a patch or minor behind their frameworks' current releases, and its Corten apps use reqwest 0.12 while axum + Maud uses 0.13](https://github.com/corten-run/corten/issues/1384).

Scope is manifests, locks and Dockerfiles under the three Rust fullstack apps,
catalog/marketplace Corten and nodelay, plus this note. A later authorized
exception includes only `bench/live/apps/corten/Dockerfile`, using the same two
pinned bases; no live Corten code or other live files are owned here. The authorized extension
also covers the fullstack Topcoat native API migration and its local tests.
Live Topcoat remains separately owned. The shared `bench/fullstack/builds.mjs`
axum + Maud tool-image recipe follows its pinned Dockerfile base. The parent must
reconcile Corten's recipe with the separately owned example Dockerfile (both
still name bookworm at the assigned base), other
Rust images and campaign provenance before a uniform new round. Root framework,
examples, template, CI, shared runners and validators are deliberately unchanged.

The refresh does not qualify only a convenient subset: preserve every selected
competitor and every required group case. A build or unit test is not native
browser/parity qualification, and a prior image's receipt cannot qualify a new
one. Any missing native check or failed gate remains missing or failed.

## Qualification record

Focused baseline and refreshed checks are recorded here as they complete.
The pinned build image was run directly: rustc 1.100.0
`(0ef1bc386 2026-11-09)`, cargo 1.100.0 `(3acc79c0c 2026-11-05)`,
Debian 13.7 trixie, glibc 2.41-12+deb13u4. This verifies the chosen base,
not any application image or its parity.

Baseline: before changing Topcoat's manifest/lock, `cargo test --locked
--manifest-path bench/fullstack/apps/topcoat/Cargo.toml` passed all 10 tests
with Topcoat 0.11.0 and reqwest 0.12.28. These cover native session/cookie
isolation/concurrency/expiry, locale and exact alert amounts, HTTP source
freshness/errors, numeric JSON, escaping and view row limits.

The new Leptos `tools` stage resolved the pinned Rust base, installed its WASM
standard library and downloaded cargo-leptos 0.3.12 using `cargo install
cargo-leptos --version =0.3.12 --locked`. The source install was deliberately
cancelled while still compiling to bound the initial check. That attempt did
not report an installation or application-build success and is not qualification.
The subsequent existing-Dockerfile production build completed installation of
cargo-leptos 0.3.12 (`Finished release ... in 109m 31s`, then `Installed package`).
At the bounded handoff, its optimized WASM compile also completed (`wasm-release`
in 17m 41s); the CLI installed wasm-bindgen 0.2.130 selected from the locked app
and started installing its requested wasm-opt `version_123`. The CLI advertised
newer wasm-opt `version_133`, but no override or opportunistic upgrade was made.
Its existing `metadata.leptos.env` key is reported as ignored; the Dockerfile
still invokes a release build and sets the runtime's production environment.
The production image, SSR release completion, final generated assets and browser
hydration are still unverified at this checkpoint. The 16 passing native SSR
tests and the explicit reqwest SSR tree check above are separate completed gates,
not substitutes for this production-image gate. No official round may proceed
on the strength of this incomplete build.

A temporary functional driver passes against the pre-refresh
`compiled-alerts-leptos` image in defaults and matched profiles: actual JS/WASM/CSS
requests and hydration, native sorting/show-all/server action/related navigation,
JS/no-JS routes, the shared catalog contract and CSS, JSON, 404 and SSE. This is
driver baseline evidence only, not qualification of the new source or assets.
The existing shared `check-alerts.mjs leptos IMAGE PROFILE all` must also run
against the new immutable image in both profiles after it exists.

### Topcoat native migration

Initially, the same native `cargo test --locked --manifest-path
bench/fullstack/apps/topcoat/Cargo.toml` after the manifest update failed with
exit 101, 20 compiler errors and 5 resulting unused-import warnings. That was not
a passing upgrade. This reproduced the source incompatibilities before migration:

- `src/main.rs:34,73`: `RouterBuilderRuntimeExt` and `.runtime()` no longer exist.
- `src/main.rs:119,145,401,406,421,436,470,485` and
  `src/marketplace_view.rs:70,193`: native component/page/procedure/route macros
  require `cx: &Cx` as their first parameter.
- `src/catalog_view.rs:24,66`: `path_param::<Id>(cx)` is no longer a function;
  `src/catalog_view.rs:38,54`: the existing `href!` calls fail expansion.

The subsequently authorized fullstack-only migration follows the upstream
[0.12 upgrade guide](https://github.com/tokio-rs/topcoat/releases/tag/v0.12.0):
explicit `cx: &Cx` parameters, `RuntimeLayer::new()` at the existing runtime layer
position, named `id(cx)`/`locale(cx)` accessors and named `href!` parameters.
No native components, routes, procedure, shards, asset declarations, request
memoization, session storage or native locale formatting are replaced.
The existing view test adds only its required `cx` argument; every assertion is
retained. The same test command now passes all 10 tests with Topcoat 0.12.1 and
reqwest 0.13.5. CLI bundle/image and actual browser checks remain separate gates.
The pinned Topcoat tools stage subsequently completed its locked 0.12.1 CLI
installation, production release and asset bundle. Actual image checks and the
separate matched-profile repair are recorded below.
The separately owned live Topcoat app is not edited or qualified here.

The first reqwest tree loop stopped at Leptos because its dependency is optional
and the default feature set does not enable SSR (`package ID specification
reqwest did not match any packages`, exit 101). The server graph must be checked
with `--features ssr`; a disabled optional dependency is not successful evidence
of the server's client major. That corrected SSR check now passes:
`cargo tree --locked --features ssr --invert reqwest --depth 1` from the Leptos
app lists `reqwest v0.13.5` with `item-page-leptos` as its dependent. The catalog,
marketplace, axum + Maud and Topcoat locked dependency-tree checks likewise
resolve reqwest 0.13.5. No second reqwest major is selected by these app graphs.

Refreshed locked native tests completed so far: catalog Corten 3, marketplace
Corten 9 (including W3C parent validation and whole-read timeout tests), axum +
Maud 8 unit plus 7 HTTP integration tests, and Topcoat 10. Nodelay compiles and
its test harness passes (0 tests). Topcoat `cargo fmt --check` passes.
Leptos SSR passes 10 unit tests, 1 native JSON integration test and 5 native POST/
security integration tests. These initially totaled 53 passing focused native
tests; nodelay has no
test cases. This is not a whole-repository check-suite or grouped-round receipt.
The later live Corten Dockerfile-only extension also passes its unchanged 4
native parity tests with the locked manifest. No live application source or lock
was changed. The focused native total including that extension was 57 tests.
The later cache-policy regression test brings the current total to 58, including
all original 10 Topcoat tests plus the new test. Topcoat formatting also passes.
Topcoat's local `tests/check-native.mjs` exercises its actual CLI-built assets,
catalog contract, typed links/404s/JSON, native SSE, sorting and offer shards,
procedure confirmation and JS/no-JS fallback. The existing
`../gin/check-alerts.mjs` is the separate fixture/API session/locale browser gate.
The new local driver was also run successfully against the existing
`compiled-alerts-topcoat` image
`sha256:a858ebb9ba9eed29a79efff88802d4dfefeab083b2100cd636b38c9f171fbbf9`
in defaults and matched profiles, including both JS modes. That is driver
baseline evidence only, not qualification or source provenance for this refresh.
That baseline reports one cold home-to-item document load and no further document
loads for sorting, offers, procedure submission or the warmed related-item link.
Topcoat's documented [native link behavior](https://github.com/tokio-rs/topcoat/blob/v0.12.1/docs/runtime/link.md#navigation-behavior)
permits a normal load when the destination needs scripts not yet loaded. The
driver counts actual document requests, not History API changes; a first attempt
to count `framenavigated` events incorrectly included same-document navigation.

Implementation slices: dependency update `5b9e9b798`, image/CLI pins
`db311536e`, native Topcoat migration/local driver `fdeac068c`, strengthened warm
navigation measurement `f9a10417e`, live Corten Dockerfile-only bases `197275f21`,
native readback cache-policy repair/regression test `239fef840`.
The committed app Git-tree identities after the migration are:

| Source directory | Git tree |
|---|---|
| `bench/fullstack/apps/axum-maud` | `fc5d18579258d47952d3f88852603decd5db2bad` |
| `bench/fullstack/apps/leptos` | `e3147b26e9d51e2cceaeb4115c08267ca968af79` |
| `bench/fullstack/apps/topcoat` | `68171323ecca77cb73d46aef2c3b57b46080ee03` |
| `bench/catalog/corten` | `6206a1c50467f09e6a5cb7a700a628a610c6278e` |
| `bench/marketplace/corten` | `d08bdaa998213e9b4ad89ae48a75a8c321c3e22b` |
| `bench/nodelay/app` | `43eb1091b9b500ba77d2aab6c0bc2fdb62e48764` |
| `bench/live/apps/corten` (only Dockerfile changed here) | `28cbd3e34189c5abe2f433d9ffa8a5ee4856dc22` |

These are source trees, not application image identities. The existing marketplace
`tests/image-source.mjs` helper reports a clean relevant source set (661 files)
and SHA-256 `b1c75c9094be1c41db8cdb99890303dc39f42855fc6f9be14baadff0a0ac44ec`.
The shared `crates` Git tree remains the assigned base's
`eee398b148c41c92805dac48cd83b90fa87eba74`; root Cargo inputs are unchanged.

### Actual Topcoat image checks and matched-profile failure

The first refreshed production image built successfully with the pinned trixie
Dockerfile, installed Topcoat CLI 0.12.1 and completed `topcoat asset bundle
--release`. Its image ID is
`sha256:44685deeea87ebd747bfd337c3504a8c60bc4d4fa2135024ccc7f4b58e352fe3`.
Runtime: Debian 13.7 and glibc 2.41. `/app/server` SHA-256 is
`22b1bd5ab202420af8f92131e45500b4255095989f2c25289af19ac783f8d550`;
the served native runtime asset SHA-256 is
`f8e40bad0d18978eb3f8db9b1747df76eecb9dc9142d9d81eb30a5aff67b73a6`.

The local native driver passes against that immutable image in both defaults
and matched profiles: actual bundle assets and immutable caching, the shared
catalog contract/CSS, typed navigation, JSON/404 routes, SSE, native shards and
procedure, JS/no-JS fallback, and escaping. It measures one cold document load
and no warmed document loads, consistent with the baseline. The existing
`check-alerts.mjs topcoat IMAGE defaults all` also passes its full fixture/API,
JS/no-JS, locale, exact money, session isolation, guards and concurrent-write
checks.

The matched alert driver **failed**, not passed: `/api/alerts` returns
`Cache-Control: private, no-cache, no-store` while the existing unchanged gate
requires exactly `no-store`. The same driver reproduces this exact failure on
the pre-refresh `compiled-alerts-topcoat` image identified above. It is a
preexisting profile/header interaction, not evidence of a new reqwest regression.
The new local regression test
`alerts::tests::readback_no_store_precedes_matched_profile_fallback` reproduces
it with native router/layer handling: exit 101, actual header values
`["private, no-cache", "no-store"]`, expected `["no-store"]`.

The repair keeps Topcoat's native `Json` serializer and
returns its cache policy in the native response-header tuple, so Tower's
if-not-present fallback sees it. It does not bypass the matched security or
timeout layer, alter cookie/session behavior, or change the shared validator.
The pre-repair refreshed image is retained locally as
`refresh-rust-topcoat-pre-no-store-fix` for reproduction, not qualification.

The repaired production image was built from the Topcoat source tree
`68171323ecca77cb73d46aef2c3b57b46080ee03` identified above, using the same
Dockerfile's installed CLI, optimized release build and actual asset bundling.
Its image ID is
`sha256:130b43a28a113b4fc28b3f4a165b253d931b7cefb29948eb6ae09dd2a6971a04`.
Its runtime reports Debian 13.7 and glibc 2.41; server SHA-256 is
`4f76e6ef836575dddfcbd53e821ebbabe1547856d56e2cc3b8b7aac952b1923a`.
The native runtime and other bundled asset hashes are unchanged from the first
refreshed image; no client behavior was rewritten to repair the response header.

Both exact-image commands pass in each of `defaults` and `matched` profiles:

```sh
node bench/fullstack/apps/topcoat/tests/check-native.mjs IMAGE PROFILE
node bench/fullstack/apps/gin/check-alerts.mjs topcoat IMAGE PROFILE all
```

The local driver passes actual assets/immutable caching, catalog contract/CSS,
JSON/404 routes, SSE, native shards/procedure, escaping and JS/no-JS navigation.
The unchanged shared alert driver passes both fixture/API sources and both JS
modes, all three locales, exact money confirmation/readback including values
above 2^53 and i64 bounds, cookie/session isolation, rejected inputs, guards,
source errors and concurrent writes. In particular, its previously failing
matched `Cache-Control: no-store` assertion now passes. The original failure is
not reclassified as a passing run.

This note is not an official grouped-run receipt or a performance measurement.
Independent review and the parent's integrated checks remain required before
the official grouped run. Guide/changelog integration outside this scope stays
with the parent.
