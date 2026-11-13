# Server runtime refresh

Based on `00fe34a735b4d8bc6d15a5d6b4e2265c2b8cbad0`; origin was fetched and
read at `4966977c8b8a7a367c0ed9087e1ae4e0b938f288` on 2026-11-13.
This is the server-runtime portion of
[#1393 bench/fullstack builds on .NET 10, Java 25, Ruby 3.4, PHP 8.4, Python 3.14, Elixir 1.19/OTP 28 and Node 24 while each runtime's newest stable is a line ahead](https://github.com/corten-run/corten/issues/1393).
The issue and every REST comment were read, including the latest-stable correction in
[#1384 bench/fullstack's apps are a patch or minor behind their frameworks' current releases, and its Corten apps use reqwest 0.12 while axum + Maud uses 0.13](https://github.com/corten-run/corten/issues/1384).
Stable, not LTS status, selects the target. New runtimes are comparison inputs,
not speedups over historical results or qualification of old images.

## Primary metadata

| App | Previous declared runtime | Selected stable runtime | Official release evidence |
| --- | --- | --- | --- |
| Rails | Ruby 3.4.12 | Ruby 4.0.9 | [Ruby releases](https://www.ruby-lang.org/en/downloads/releases/) |
| Laravel | PHP 8.4, FrankenPHP bookworm | PHP 8.5.12, FrankenPHP trixie | [PHP release JSON](https://www.php.net/releases/index.php?json&version=8.5) |
| Django, FastAPI | Python 3.14 | Python 3.15.2 | [Python release API](https://www.python.org/api/v2/downloads/release/?is_published=true), [release notes](https://docs.python.org/release/3.15.2/whatsnew/changelog.html) |
| Phoenix | Elixir 1.19 / OTP 28 | Elixir 1.20.5 / OTP 29.1.2 | [Elixir stable release](https://github.com/elixir-lang/elixir/releases/tag/v1.20.5), [OTP stable release](https://github.com/erlang/otp/releases/tag/OTP-29.1.2) |
| Spring | Java 25 / Maven 3.9 | Temurin 27.0.1.0.2+1 / Maven 3.10.0 | [Adoptium releases](https://api.adoptium.net/v3/info/available_releases), [Java 27 GA assets](https://api.adoptium.net/v3/assets/feature_releases/27/ga?architecture=x64&image_type=jre&os=linux&vendor=eclipse), [Maven Central metadata](https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml) |

The official Docker registries published each selected image. The Dockerfiles pin
the multi-platform index digest, not only an architecture-specific image. Maven's
metadata also lists 4.0.0-rc-7; it is not a stable release and is not selected.

| Image | Published index digest |
| --- | --- |
| `ruby:4.0.9-slim` | `sha256:d8cb2c0714bdaba0f318af897a01d2dbde3cfa8e62d47e99cea55feb13c0e90d` |
| `dunglas/frankenphp:1-php8.5-trixie` | `sha256:667c5fffd348d9c3c260803d75956f1d9aace7e4b7331d8893de6f101d7e0e57` |
| `python:3.15.2-slim` | `sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928` |
| `elixir:1.20.5-otp-29` | `sha256:1b850191faeaae55678b782cd8b34d391f793672f3175b1956d024f794ca321b` |
| `debian:trixie-slim` (Phoenix release runtime) | `sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2` |
| `maven:3.10-eclipse-temurin-27` | `sha256:3175c44b207d6698aecb9bbb5bf285b5b4efcf7f567d6f65d88cd218276a6ab2` |
| `eclipse-temurin:27-jre` | `sha256:05a57c9f4d6d8bf8d8c2213049ea816609672ffcc14463a9c83433a610703e10` |

## Scope and verification

Only these six app subtrees and this note change. Native transports, form/security
behavior, defaults/matched profiles and worker policies remain unchanged. Shared
build recipes, Node/htmx refreshes, the changelog, full integration and independent
review belong to the parent lane. In particular, shared Spring/Python toolchain
recipes still declare the old runtimes at this base and need the parent's update;
Rails/Laravel/Phoenix recipes obtain their tools stage from the app Dockerfile.

All six production images build and pass native tests and default-profile
catalog/marketplace checks for both sources. No result is qualified merely from an image tag or
the previous server-refresh checks. The PHP decimal and Phoenix initial-edit/
reconnect regressions are required on the refreshed images. Actual incompatibilities
and inherited framework failures will remain visible rather than changing gates,
workers or runtime lines to hide them.

The PHP base actually reports PHP 8.5.12 ZTS, FrankenPHP 1.13.5 and Caddy
2.11.9. The Spring build actually reports Temurin 27.0.1.0.2+1 and Maven
3.10.0. The [Spring Boot 4.1.2 system-requirements source](https://github.com/spring-projects/spring-boot/blob/v4.1.2/documentation/spring-boot-docs/src/docs/antora/modules/ROOT/pages/system-requirements.adoc)
explicitly supports Java 27.

Original runtime-check app inputs were frozen at `cdb81f523050dc15419eeb3e0cd757eb13c08b93`:
Rails `1f07f2086`, Python `14152315e`, Spring `54ad3fbb1`, Laravel
`70d3a9079`, Phoenix `cdb81f523`. Each slice contains only runtime inputs.
The unchanged marketplace checker SHA-256 is
`9e4f8d9c252dbb32e5221673dbf852a8950cd3306725f1658ec5ee78c6c1dc02`;
catalog checker SHA-256 is
`06927befe19edb5d5334fb5d209ab1a65e91dafbb6175d68c45c9096c89f92c0`.

Observed runtime compatibility results, not whole-profile/load qualification:

| App | New-image observations |
| --- | --- |
| Rails | Production build; Ruby 4.0.9; 13 tests/203 assertions with no failures; all six native ordinary/Turbo alert security/state/navigation profiles pass; catalog and marketplace fixture/API gates pass |
| Django | Both production profiles build; Python 3.15.2; 39 tests per profile with seven/one expected skips; pip consistency passes; default catalog and marketplace fixture/API gates pass |
| FastAPI | Original 0.162.5 production build; Python 3.15.2; 28 tests per profile pass; pip consistency passes; default catalog and marketplace fixture/API gates pass. The corrective 0.162.7 retake below supersedes only this app's version qualification |
| Spring | Production build; native Maven tests exit 0 (13 test methods); catalog and marketplace fixture/API gates pass |
| Laravel | Production build; all native PHP suites/platform checks/strict Composer validation/locked audit pass, including 80 concurrent appends; six ordinary/Livewire alert profiles and 42 accepted decimal-boundary submissions pass; catalog and marketplace fixture/API gates pass |
| Phoenix | Production release; actual Elixir 1.20.5/OTP 29.1.2; ten native tests, formatter and Hex audit pass; six ordinary/LiveView alert profiles and EN/FR ordinary/connected/delayed-connect/reconnect regressions pass; catalog and marketplace fixture/API gates pass |

OSV query-batch checks returned zero matches for actual resolved Django matched
(18 packages), FastAPI (61), Rails (77), Spring runtime (46) inventories and
36 evaluated Phoenix Hex lock entries.
These package-version queries are not a whole-image/OS vulnerability scan.
Ruby's locked Bundler 2.6.9 emits duplicate Gem platform-constant warnings on
Ruby 4; tests pass with the lock unchanged, and the warnings are not suppressed.

The scratch runner's first Django catalog fixture/API attempts failed because
HTTP Docker hostnames are not potentially trustworthy for Django's unchanged
COOP header. Their failed logs are retained. Using localhost in the native app's
network namespace passes the same unchanged checker; no header, error assertion,
or native security policy was removed. Default browser results do not establish
load/mixed-client qualification.
Inherited Django sync/matched WSGI abort-cleanup and Spring blocking request
lifetime limitations remain as documented in the earlier server refresh.

Both Python matched profiles fail catalog fixture and API browser gates at
`check.mjs:182`, with their unchanged `style-src 'self'` CSP blocking htmx 2.0.11's
default indicator-style injection. The exact generated CSS SHA-256 base64 is
`faU7yAF8NxuMTNEwVmBz+VcYeIoBQ2EMHW3WaVxCvnk=`, matching every browser error.
The native script has `includeIndicatorStyles:true` and inserts that style in
`head`; the base template has no htmx-config override. These four real failures
are retained, not suppressed or repaired in the runtime-only lane: the htmx
owner must integrate its native CSP-compatible refresh and recapture the gates.
Django and FastAPI matched marketplace fixture/API pass. No profile is switched
off and no worker count is reduced. These four matched catalog failures prevent
a whole-matrix pass despite successful runtime migrations and marketplace checks.
The measured final matrix is 28 passing and four failing app/profile/workload/
source checks. The initial origin-setup attempts are retained separately; final
Django marketplace fixture/API checks were also retaken successfully on localhost.

## New image identities

Original image inputs match the original frozen app source above. Some builds began before its
commits were made and therefore record the original base plus a dirty context;
the app file contents did not change between builds and the frozen app commits.
These local functional captures are not a frozen integrated release/campaign
receipt: the parent still owns the shared recipe/htmx integration and review.

| Image | Local image SHA-256 |
| --- | --- |
| Rails | `770d84e7f1ac486a8dbd849cb712c6426ebb0ef9471646d4947fa9d111dbf53e` |
| Django defaults | `4f90cb7c395ffb1a0d0ae7f8813b20d17a655a39efc428fb22dc1edcc8d3efad` |
| Django matched | `95c787348589a815502c850c01ff81d792cf4af925f0280cb92ffe7be6c23421` |
| FastAPI defaults/matched | `fab2607a1185e96cc43553dcaca4f917bf776b4d8cf3226ccb2ac9947bb0fbe4` |
| Laravel | `433ce62cfaa2006b0638c036b30c6d234226328738c1456e506e12c864daa2d7` |
| Phoenix release | `3719e14de318ddf43be38e993330d1cfce7e8b46749f9ce1b2733b95e57dd3cb` |
| Phoenix native-test build stage | `7ae6e1172ad3e2078a8e116473c9abe24174e2df68362900a2ae96561d0fce71` |
| Spring release | `dad330d1fb210ae789da59bdeaf41c420569409cbd503ccb55015b302dac6e58` |
| Spring native-test build stage | `2e6918eeb4ec57819a37fa1b54cac3a1c158b22f0868d592ba2aa1e7a2eb9fd7` |

OTP's exact patch was read from the build image's `OTP_VERSION`; the assembled
release does not retain that file at its VM root. An initial inventory-only
attempt to read that release path exited 1, not an app/gate failure. The probe
also emitted an optional `libsctp.so.1` warning; the used HTTP/WebSocket native
gates pass without adding an unused SCTP dependency or suppressing that warning.

All directly created verification containers were removed with their volumes;
no task network or volume remains. Labeled new images are retained for parent
review/retakes. Raw logs, scripts, package queries, failed matched gates and image/
app-tree/checker hash manifests are retained as local handoff evidence, not
committed receipts. No cloud, push, root/framework/CI edit, performance campaign,
or historical speedup claim was made. Full integration, repository-wide checks,
updated-source recapture and independent review remain with the parent.

## Review handoff

Origin was fetched again at `3bafe4eeff6dfee6f6134203fd267f6003977565`.
The merged Node runtime refresh does not change these six server app inputs,
the Python htmx configuration, or the shared Python/Spring toolchain recipes.
It therefore does not resolve or supersede the four retained matched catalog
failures. No failed capture was overwritten and no fresh integrated pass is
claimed by this note-only checkpoint.

The six app-tree identities, both checker hashes, all 119 retained evidence
files and all ten retained image entries were rechecked against the frozen
manifest with no mismatches. This verifies evidence integrity, not another run
of the builds or gates. The production build/native test/default fixture/API
checks above are complete for these frozen inputs; there is no unreported
server-runtime compatibility failure or pending app-local production build.

Before release, the integration owner must combine the independently reviewed
server framework/native-app foundation with these runtime-only slices, update
the shared Python and Spring build recipes to the same toolchains, integrate the
htmx owner's CSP-compatible update, then rebuild and run the full fixture/API
matrix on that exact combined source. The ordinary/native alert checks must
also be retaken, including decimal boundaries and delayed LiveView connection.
The existing 28/32 matrix remains partial until that succeeds. Shared native-live
registration and the separate Laravel live port do not belong to this patch.

### Shared recipe companion

The parent-owned `bench/fullstack/builds.mjs` needs exactly these server `tools`
values to match the frozen Dockerfiles; no Node, .NET or htmx line is part of
this companion:

| Recipe | Required `tools` value |
| --- | --- |
| `spring` | `maven:3.10-eclipse-temurin-27@sha256:3175c44b207d6698aecb9bbb5bf285b5b4efcf7f567d6f65d88cd218276a6ab2` |
| `django`, `fastapi` | `python:3.15.2-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928` |

Keep Rails `tools: "bb-tools-rails"` / `stage: "bench/fullstack/apps/rails"`,
Laravel `tools: "bb-tools-laravel"` / `stage: "bench/fullstack/apps/laravel"`,
and Phoenix `tools: "bb-tools-phoenix"` / `stage: "bench/fullstack/apps/phoenix"`.
The builder builds each named Dockerfile's `tools` target, so those three recipes
already inherit the pinned Ruby 4.0.9, PHP 8.5.12 and Elixir 1.20.5/OTP 29.1.2
inputs when the runtime slices are imported. Their labels are local stage-image
names, not external runtime tags. Spring's owned `pom.xml` also sets
`java.version` to 27; Rails' owned `.ruby-version` is `ruby-4.0.9`.
No dependency/build command, environment, worker policy, edit target or htmx ADD
needs changing for this runtime companion. The direct production-build proof
above does not establish build-benchmark recipe parity until the parent applies
and checks these three `tools` replacements on the combined source.

## FastAPI review correction

Review found that the original 0.162.5 pin was already behind at the prior
handoff. Fresh [official PyPI metadata](https://pypi.org/pypi/fastapi/0.162.7/json)
identifies stable, non-yanked 0.162.7, uploaded 2026-11-13T17:47:16.598936Z;
0.162.6 was published at 13:36:38.005177Z that day. A final registry read still
selects 0.162.7. The
[maintainer release notes](https://github.com/fastapi/fastapi/releases/tag/0.162.7)
describe cancellation cleanup for async-yield dependencies. This application has
no yield-based dependency providers; its existing request-disconnect, deadline,
owned-task cancellation, serialization-error and trace-cleanup tests remain
enabled, not replaced with a synthetic route or weakened checks.

The corrected app source is `7bab53f369ed9f2be7c239621f850c45db948dff`, app-tree
`841bd3e1d241fcdf3a4aa872831cd0b6d736b35d`. Only FastAPI's requirements pin changes;
the second review repair labels the supplied fullstack Gin Go 1.27.3 checks as
historical/pending instead of claiming they qualify Go 1.27.4/templ 0.3.1118.
No new fullstack Gin qualification is claimed. Shared recipes remain parent-owned.

The actual new FastAPI production image is
`sha256:8b9c99d45e00495ee64f46844d5fb1320247d32bcfeac015ea632475373c6f7e`.
Its source labels identify that commit/tree. It reports FastAPI 0.162.7 on Python
3.15.2, passes dependency consistency and 28 native tests in each defaults/matched
profile. OSV query-batch returned zero matches for its 61 installed packages,
not a whole-image/OS scan. Its own resolved inventory is retained separately
from the 0.162.5 image's inventory.

The unchanged catalog/marketplace checkers and htmx 2.0.11 remain in this retake.
Six of eight profile/workload/source cases pass: both default catalog sources
(500 JSON records/120 page checks each), and marketplace fixture/API for both
profiles (500 JSON records/264 page checks/twelve locale/JS/mobile profiles each).
Both matched catalog sources still fail the original strict CSP assertion with
the same indicator CSS digest recorded above. Those two genuine failures remain
visible. This is not an all-green matrix or a htmx 4 result.

Three initial scratch-run attempts stopped because the isolated oracle context
omitted reference CSS, after reaching its JSON checks. Their original failure
logs remain. Exact reference CSS from the same frozen source was then supplied
without altering the app image or oracle, and those three cases were fully
retaken in separate evidence directories. These setup failures are not relabeled
as native app failures or erased. The first pipeline exit remains nonzero.

The earlier 28-pass/four-fail six-app evidence remains historical and untouched;
it does not qualify the new FastAPI patch. The separately attributed FastAPI
retake is six-pass/two-fail. No htmx overlay, native transport, worker, runtime
pin, CSP policy or shared gate changes in this corrective slice. All directly
created retake containers and networks were removed, with no task volume left.
The labeled image, package metadata, source/image/checker hashes and all original,
failed and retaken logs remain local review evidence. Independent fresh review,
parent import and exact-source composed htmx/runtime qualification are still
required before release. The older prepared htmx context bound to `d16da6316`
cannot qualify this new source and must be recomposed explicitly.
