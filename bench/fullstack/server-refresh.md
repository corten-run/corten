# Server dependency refresh

Checked against official registries on 2026-11-13. These are production comparison
inputs, not performance measurements or changes to published baselines. Worker
counts, native transports and benchmark gates stay unchanged. The refresh includes
native Rails, Phoenix and Laravel marketplace alerts and correctness repairs.

## Versions

| App | Selected versions | Primary evidence |
| --- | --- | --- |
| Gin | Gin remains 1.12.0; Go 1.27.4; templ 0.3.1118; x/net 0.62.0; x/crypto 0.59.0; x/text 0.44.0; quic-go 0.59.1; x/sys 0.50.0 | [Go](https://go.dev/dl/?mode=json), [templ](https://proxy.golang.org/github.com/a-h/templ/@latest), [net](https://proxy.golang.org/golang.org/x/net/@latest), [crypto](https://proxy.golang.org/golang.org/x/crypto/@latest), [text](https://proxy.golang.org/golang.org/x/text/@latest) |
| Rails | Rails 8.1.4.1; Ruby 3.4.12; Rack 3.2.8; Puma 8.0.3; Bootsnap 1.26.1; Loofah 2.25.3; Nokogiri 1.19.7; msgpack 1.8.7; rails-html-sanitizer 1.7.2 | [Rails](https://rubygems.org/api/v1/gems/rails.json), [Rack](https://rubygems.org/api/v1/gems/rack.json), [Puma](https://rubygems.org/api/v1/gems/puma.json), [Ruby](https://hub.docker.com/_/ruby) |
| Phoenix | Phoenix remains 1.8.16; Bandit 1.14.1; phoenix_html 4.4.0; plug_crypto 2.2.1; ex_cldr_numbers 2.38.4 | [Bandit](https://hex.pm/api/packages/bandit), [HTML](https://hex.pm/api/packages/phoenix_html), [plug_crypto](https://hex.pm/api/packages/plug_crypto), [CLDR](https://hex.pm/api/packages/ex_cldr_numbers) |
| Django | Django 6.1.3; Gunicorn 27.0.1 | [Django](https://pypi.org/pypi/Django/json), [Gunicorn](https://pypi.org/pypi/gunicorn/json) |
| FastAPI | FastAPI 0.162.7 | [Versioned PyPI metadata](https://pypi.org/pypi/fastapi/0.162.7/json) |
| Laravel | Framework 13.42.0; Octane 2.24.0; Reverb 1.13.0; Tinker 3.1.0; Livewire remains 4.4.8; Guzzle 7.16.1; PSR-7 2.13.3; Promises remains 2.6.0; Brick Math 1.0.0 made explicit | [Framework](https://repo.packagist.org/p2/laravel/framework.json), [Octane](https://repo.packagist.org/p2/laravel/octane.json), [Reverb](https://repo.packagist.org/p2/laravel/reverb.json), [Livewire](https://repo.packagist.org/p2/livewire/livewire.json), [Brick Math](https://repo.packagist.org/p2/brick/math.json) |
| Spring | Boot 4.1.2; its BOM resolves Spring Framework 7.0.10, Tomcat 11.0.27 and Jackson 3.1.7 | [Maven Central](https://repo.maven.apache.org/maven2/org/springframework/boot/spring-boot-starter-parent/maven-metadata.xml) |
| Drogon | Drogon remains 1.9.14; dated trixie build/runtime bases become 20261104 | [Stable release](https://api.github.com/repos/drogonframework/drogon/releases/latest), [build image](https://hub.docker.com/v2/repositories/library/debian/tags/trixie-20261104), [runtime](https://hub.docker.com/v2/repositories/library/debian/tags/trixie-20261104-slim) |

Native package managers regenerated the lockfiles. Go and quic-go retain their
release lines with fixes identified by the [Go advisory](https://vuln.go.dev/ID/GO-2026-6859.json)
and [quic-go advisory](https://vuln.go.dev/ID/GO-2026-5676.json). Laravel retains
compatible Guzzle major lines. Spring 4.2 was a release candidate, not the stable
patch selected here; transitive Spring versions come from its BOM.

The [Rails cache advisory](https://github.com/rails/rails/security/advisories/GHSA-2586-8ghr-69fj)
excludes this app's CookieStore, and this app does not install the path-specific
Rack static rules affected by the [Rack advisory](https://github.com/rack/rack/security/advisories/GHSA-wvg4-6p58-3gh3).
The updates do not claim this benchmark exposed those exploits. Package audits
below do not substitute for replaying every upstream exploit.

## Native verification

| App | Completed checks |
| --- | --- |
| Gin | Historical supplied checks used Go 1.27.3, not the selected Go 1.27.4/templ 0.3.1118 source above. Exact new-source/image/version production, native and fixture/API checks remain pending; old checks do not qualify the refresh |
| Django | Production builds; 39 Django tests per defaults/matched profile, respectively seven/one expected profile skips; dependency consistency and matched-inventory OSV audit; catalog/marketplace fixture and API gates |
| FastAPI | Earlier production/native/correctness/audit observations cover 0.162.5 only. Fresh 0.162.7 results are recorded separately in the runtime refresh note; old images do not qualify the new patch |
| Rails | Production build; 13 tests, 203 assertions, zero failures/errors/skips; dependency audit; six-profile native alert browser regression; catalog/marketplace fixture and API gates |
| Phoenix | Production release; final formatter/marketplace tests: ten tests, zero failures; native accepted/rejected state/readback; six-profile native alerts; initial-edit/reconnect regression; Hex and evaluated-lock OSV audits |
| Spring | Production build; 13 Maven tests, zero failures/errors/skips; OSV audit of all 30 resolved runtime dependencies; catalog/marketplace fixture and API gates |
| Laravel | Production build; strict Composer validation/locked audit; native items/catalog/marketplace/alerts tests including 80 concurrent appends; six-profile browser regression and 42 accepted decimal-boundary submissions |
| Drogon | Production/build-stage images; three CTest tests; six Docker-argument cases; twelve rejected startup fixtures; native fixture/API catalog/marketplace JSON checks, 500 exact records each plus cleanup/recovery controls |

Drogon's framework commit, Trantor, flags, app sources and tests are unchanged by
its base refresh. The runtime reports Debian 13.7, OpenSSL package 3.5.7-1~deb13u3,
JsonCpp 1.9.6-3 and ICU 76.1-4. No complete OS vulnerability scan is claimed.
Drogon's bases later moved to `trixie-20261123`, by digest
([Debian 13.8 refresh](../workloads/version-refresh-rust.md#debian-138-refresh-2026-11-26)).

The selected FastAPI patch was corrected after review: PyPI publishes non-yanked
0.162.6 at 2026-11-13T13:36:38Z and 0.162.7 at 2026-11-13T17:47:16Z, both before
the earlier runtime handoff. A fresh registry read selects 0.162.7, not the stale
0.162.5 input. The separate native-live Gin runtime follow-up is a different
application and does not supply the missing fullstack Gin qualification above.

## Correctness repairs

Laravel originally confirmed 1.01 but stored 100 for `1.005`/`1,005` through
ordinary and real Livewire saves. The original ICU-validated decimal now drives
half-up conversion with locked Brick Math, not a binary-double parse. ICU int64
whole-unit formatting plus exact cents preserves readback above binary-double
precision. Permanent PHP/browser regressions cover all locales, ordinary/Livewire
forms, exact confirmation/readback and overflow rejection. Correctness has a real
formatting cost; no comparative speed claim is made.

Phoenix originally erased dirty, blurred fields when its first join reply arrived
after editing. A form ID and `phx-change` alone did not fix it. The pinned
[LiveView source](https://github.com/phoenixframework/phoenix_live_view/blob/v1.2.13/assets/js/phoenix_live_view/view.ts)
skips recovery on the first join. Its documented [DOM callbacks and hooks](https://github.com/phoenixframework/phoenix_live_view/blob/v1.2.13/guides/client/js-interop.md)
now preserve only initial dirty email/target values and synchronize them with the
same non-writing change event. Preservation ends at native mount; normal recovery
owns reconnects. No subtree ignore, replacement renderer, disabled JavaScript,
forced transport or altered fallback is used. Permanent EN/FR ordinary, connected
and held-first-join tests pass, including blur, disconnect/edit/reconnect, invalid
rejection and a later valid save/readback.

Final native repair images:

| App | Image SHA-256 |
| --- | --- |
| Laravel | `9c60c7777bfa153a9447b44e853cdc49b65a444431d661e7310721468be8bb1c` |
| Phoenix | `22961ae438236d821b6c0cffd1d67f9da5ec18f39cebc245cfca5b34bdeb5099` |

## Limits

Original Phoenix marketplace gates assumed HTTP POST saves instead of native
WebSocket/long-poll messages. Earlier checker snapshots, unfrozen parent captures
and an API setup failure are not final exact-source qualification. Original Laravel
URL-recognition failures remain historical too. Native controls above are distinct
from the parent's frozen-checker follow-up and complete grouped campaign admission.

Setup failures included an incorrect Rails fixture mount, Phoenix origin mismatch
and a scratch container-name collision. Those were corrected without changing
the app contract or gate; interrupted runs are not passes.

This does not close [#1300 Benchmark parity: Drogon in approved workload groups](https://github.com/corten-run/corten/issues/1300).
Its prior parser diagnostic retained four of eight failures and 48 of 96 repeated
tracestate failures. Those are different-source diagnostics, not results of this
base-only refresh, and require separate repair/retest. No filtering or gate
weakening is included here.

Original sanitized development evidence, failed attempts and the unabridged note
remain in operator review artifacts. This concise note omits private branch-history
citations rather than presenting them as merged evidence. No grouped timing
baseline, complete group qualification or root framework/image refresh is claimed.

## Security re-pin (2026-11-23)

[#1376 bench/fullstack runs Rails, Phoenix, Gin and Nuxt on releases with published security fixes, so its production comparison is not each framework's supported configuration](https://github.com/corten-run/corten/issues/1376)
lists published security fixes that the 2026-11-13 refresh predates or did not reach.
New builds take the patched release in each framework and runtime line; no OS base changes.
The exception is the live Gin app's four pre-1.0 `golang.org/x` modules (net, crypto, text,
sys): they cross minor versions on purpose, to the fixed versions the fullstack Gin app
already uses, so both Gin apps build the same versions of the modules this change moves
(their other modules, such as go-isatty, still differ).
Rounds and groups measured before this change keep the versions their commit and receipts
record, and nothing here is a performance measurement.

| App | Change | Advisories fixed |
| --- | --- | --- |
| bench/live Gin | x/net 0.51.0 to 0.62.0, x/crypto 0.48.0 to 0.59.0, x/text 0.34.0 to 0.44.0, x/sys 0.41.0 to 0.50.0, quic-go 0.59.0 to 0.59.1 (the fullstack Gin app's versions); Go stays 1.27.4, the newest release | 16 x/net entries, among them GO-2026-6860 and GO-2026-6866; 30 x/crypto entries, among them GO-2026-6355; GO-2026-5970 and GO-2026-6629 (x/text); GO-2026-5024 (x/sys); GO-2026-5676 (quic-go) |
| Both Phoenix apps | Plug 1.20.3 to 1.20.4, Phoenix 1.8.16 to 1.8.17, LiveView 1.2.13 to 1.2.15; mix.exs floors raised to match | [EEF-CVE-2026-120287](https://osv.dev/vulnerability/EEF-CVE-2026-120287) (multipart length limit), [GHSA-pvfx-rx4x-phrr](https://github.com/phoenixframework/phoenix/security/advisories/GHSA-pvfx-rx4x-phrr), [GHSA-5vmc-qgf8-rw36](https://github.com/phoenixframework/phoenix/security/advisories/GHSA-5vmc-qgf8-rw36), [GHSA-v4p7-3pm2-wq6c](https://github.com/phoenixframework/phoenix_live_view/security/advisories/GHSA-v4p7-3pm2-wq6c) |
| Both Rails apps | Ruby 4.0.9 to 4.0.10 (the image stays Debian 13); Rack 3.2.8 to 3.2.9 | [Regexp and String advisories](https://www.ruby-lang.org/en/news/2026/11/18/multiple-vulnerabilities-in-regexp-and-string/); Rack's [3.2.9 security fixes](https://github.com/rack/rack/blob/v3.2.9/CHANGELOG.md): [GHSA-r243-pfwh-7rpx](https://github.com/advisories/GHSA-r243-pfwh-7rpx), [GHSA-58mf-c3jj-277p](https://github.com/advisories/GHSA-58mf-c3jj-277p), [GHSA-mhj6-xc86-54m8](https://github.com/advisories/GHSA-mhj6-xc86-54m8), [GHSA-frgv-948x-h96g](https://github.com/advisories/GHSA-frgv-948x-h96g), [GHSA-f7cc-57h7-qrcg](https://github.com/advisories/GHSA-f7cc-57h7-qrcg) |
| Spring | Same tags, current digests: Temurin 27.0.1.0.2+1 to 27.0.1.1+4, Maven 3.10.0 and Ubuntu 26.04.1 unchanged | [jdk-27.0.1.1+4](https://github.com/adoptium/temurin27-binaries/releases/tag/jdk-27.0.1.1%2B4), the November Critical Patch Update |

| Image | Published index digest |
| --- | --- |
| `ruby:4.0.10-slim` | `sha256:dc488b2df1731a1523a24a845fc38627b3edde052473c4e7bef06ae4d649fd25` |
| `maven:3.10-eclipse-temurin-27` | `sha256:a83dca2f65c72ace081f55a63231adbd6d88741caa4fdc68f7d5c9e450d1070c` |
| `eclipse-temurin:27-jre` | `sha256:8f8cfda6393f63a029dbe83ceda4c19a31d268184662e96d9641f57afdaf870b` |

The Ruby tag was pushed again on 2026-11-22, so its digest differs from the one the issue's
2026-11-19 comment gives; both are Ruby 4.0.10 on Debian 13. The versions above were read
from the images (`ruby -v`, `java -version`, `mvn -v`, `/etc/os-release`). Mix and Go
regenerated the locks in the apps' own pinned toolchain images. `mix deps.update` also
offered telemetry 1.4.3 and, in the fullstack app, websock_adapter 0.7.2; the new releases do
not require either, so the locks keep 1.4.2 and 0.6.0, and `mix deps.get` in each
environment leaves the locks unchanged. The LiveView entries are exactly what Mix writes:
unlocking `phoenix_live_view` and running `mix deps.get` again (Hex 2.7.0) rewrites them
byte for byte. Hex writes the published requirements in a reduced, equivalent form, so
`~> 0.6 and >= 0.6.16` (Igniter) reads `>= 0.6.16 and < 1.0.0-0` and
`~> 3.3 or ~> 4.0 or ~> 4.1` (Phoenix HTML) reads `~> 3.3 or ~> 4.0`. Bundler moved only Rack
(`bundle update --conservative rack` on the apps' Ruby 4.0.10 image, with each lock's own
Bundler version). Rack 3.2.9 also rejects an unquoted multipart boundary outside RFC 9110's
token grammar; browsers quote or generate valid boundaries, and the checks below pass with it.

After the change, an OSV query batch over the live and fullstack Gin `go.mod` files (with
Go's standard library at 1.27.4), both Phoenix `mix.lock` files and both Rails
`Gemfile.lock` files (270 package versions) returned no advisory; the same query on the
previous files returned the advisories in the table. These are package-version queries, not
an image or OS scan, and OSV did not index Rack 3.2.9's five advisories when queried, so it
reported no Rack advisory before or after that change. The same query over the fullstack Nuxt
app's `package-lock.json` (unchanged here) returns Nuxt 4.6.4 and `@nuxt/nitro-server` 4.6.4,
whose advisories GitHub bounds below 4.6.4 on the 4.x line (OSV's 3.x ranges are open-ended),
and two real matches: glob 13.0.7 (GHSA-3g3m-2fjr-6pw4, fixed in 14.0.2) and minimatch 10.2.6
(GHSA-g3hv-75wg-m249, fixed in 11.0.1). Both are the newest releases of their majors, reached
through Nitro's build-time `@vercel/nft` and `archiver`; neither is in the `.output` the Nuxt
image runs. They stay until a follow-up takes those majors.

Checks on the changed apps, run locally on Docker Desktop with the commit's sources, not on a
benchmark host: catalog fixture and API checks for Spring, Rails and Phoenix (500 JSON records
and 120 page checks per source), marketplace fixture and API checks for the same three (500
records, 264 page checks and 12 profiles per source), `check-app.mjs` for each against
Corten, the Rails app's 13 tests (203 assertions) on Ruby 4.0.10, Spring's 19 Maven tests on
Temurin 27.0.1.1+4, Phoenix's 10 tests and `hex.audit`, bounded live-delivery parity for the
live Gin, Rails and Phoenix apps (2 of 2 journeys each, verified by `bench/live/verify.mjs`),
recoverable-live parity for live Rails and Phoenix (6 of 6 each), the live Rails store test
(12 runs) and Phoenix store test (14), and `node --test` over `bench/live` and the
workloads live and deployments suites. The Phoenix catalog image first failed to build when
ex_cldr could not reach `raw.githubusercontent.com` for the German locale; the same build
passed on the next attempt. `mix format --check-formatted` reports seven unformatted files
in the fullstack Phoenix app, the same seven at the commit before this change. After Rack
moved to 3.2.9: `check-app.mjs` for Rails and Phoenix, catalog and marketplace fixture and API
checks for Rails, Phoenix and Nuxt (the same counts as above), live-delivery (2 of 2) and
recoverable-live (6 of 6) parity for live Rails and Phoenix, the fullstack Rails tests (13
runs, 203 assertions) and the live Rails store test (12 runs) all passed.

### Nuxt tracer refresh

A later lockfile refresh takes `@vercel/nft` 1.11.16 within Nitro's existing
range. That tracer now uses `glob` 14.0.6 and its own `minimatch` 11.0.9.
This removes the old `glob` from the lock, **not** every copy of `minimatch`
10.2.6: `archiver` 8 still takes `readdir-glob` 3, which requires that major.
No override is used. Future Nuxt builds use different build tools; this does
not change an earlier run's inputs or establish a performance difference.

With the lock at `d49e439b5`, the production Dockerfile built. On that image
all 13 catalog, marketplace and alert unit checks passed, as did the marketplace
HTTP suite (three checks, including both fixture and HTTP sources). These are
local build and behavior checks, not a new timed result.
