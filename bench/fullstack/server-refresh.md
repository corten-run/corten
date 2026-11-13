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
