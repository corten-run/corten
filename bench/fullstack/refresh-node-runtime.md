# Node runtime refresh

This focused release starts from fetched main `5696f124e5c2db21dbb7b3b78d9bf7d7ec1fb954`.
It imports only the 22 authorized production pin, test and note paths from the
frozen author lane, plus the two explicitly authorized Node recipe pins in
`bench/fullstack/builds.mjs`. The separate parent companion patch is not imported.
It changes benchmark Node runtime inputs, not framework APIs, benchmark workloads,
historical results, htmx, root tooling or CI. Integration and independent review are pending.

## Current official metadata

Checked 2026-11-13, after reading GitHub REST issue metadata and every comment using
paginated REST requests for
[#1393 bench/fullstack builds on .NET 10, Java 25, Ruby 3.4, PHP 8.4, Python 3.14, Elixir 1.19/OTP 28 and Node 24 while each runtime's newest stable is a line ahead](https://github.com/corten-run/corten/issues/1393)
and
[#1385 bench/browser and client-heavy build Remix 3.0.0, Solid, Svelte and Vue a release behind, with @babel/core 7.28.5 carrying a published advisory](https://github.com/corten-run/corten/issues/1385).
The latter's latest comment explicitly targets Babel 8, not the newest Babel 7 patch.

The [official Node release index](https://nodejs.org/dist/index.json) lists
**26.13.1**, dated 2026-11-10, as the newest non-prerelease. Its newer 27 entries are
alpha releases. Selection is by newest stable version, not by support term.
The version's [official checksums](https://nodejs.org/dist/v26.13.1/SHASUMS256.txt)
were also used to verify the Node executable used for host-side checks.

Docker's official registry returned these multi-platform index digests; both include
Linux amd64 and arm64 images. Application build and production stages use the same
Bookworm reference, preserving their existing distribution. Alpine helpers retain Alpine.

| Exact official image | Verified index digest |
|---|---|
| `node:26.13.1-bookworm-slim` | `sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1` |
| `node:26.13.1-alpine` | `sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5` |

Primary image sources: [Docker Official Node image](https://hub.docker.com/_/node),
[Node Docker definitions](https://github.com/nodejs/docker-node).
The complete `tag@sha256` references are committed, not floating major tags.

## Babel 8 is blocked

Official npm `latest` metadata returned:

| Direct browser input | Current stable |
|---|---|
| `@babel/core` | 8.1.2, Node `^22.18.0 || >=24.11.0` |
| `babel-preset-solid`, `solid-js` | 1.9.19 |
| `remix` | 3.2.0, Node `>=24.3.0` |
| `svelte` | 5.57.3 |
| `vue` | 3.5.45 |
| `react`, `react-dom` | 19.3.1 |
| `esbuild` | 0.28.2 |

Primary metadata: [Babel](https://registry.npmjs.org/@babel%2fcore/latest),
[Solid preset](https://registry.npmjs.org/babel-preset-solid/latest),
[Solid](https://registry.npmjs.org/solid-js/latest), [Remix](https://registry.npmjs.org/remix/latest),
[Svelte](https://registry.npmjs.org/svelte/latest), [Vue](https://registry.npmjs.org/vue/latest),
[React](https://registry.npmjs.org/react/latest), [React DOM](https://registry.npmjs.org/react-dom/latest),
[esbuild](https://registry.npmjs.org/esbuild/latest).

Stable `babel-preset-solid@1.9.19` declares peer `@babel/core: ^7.0.0`.
It depends on `babel-plugin-jsx-dom-expressions: ^0.40.14`. The requested Babel 8
does not satisfy the preset's published contract. With the browser's complete direct
dependency set copied into a scratch package, changing only Babel to 8.1.2,
Node 26.13.1 / npm 11.20.0 returned exit 1 for
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund`:

```text
npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error Found: @babel/core@8.1.2
npm error Could not resolve dependency:
npm error peer @babel/core@"^7.0.0" from babel-preset-solid@1.9.19
```

The browser manifest and lock therefore remain unchanged, including Babel 7.29.13
and the previously refreshed stable renderers. This is an unresolved Babel 8 upgrade,
not a claim that Babel 7 meets the latest-stable target. No force, legacy-peer-deps,
peer override, vendored patch, replacement renderer, compiler filtering or weakened
gate was used. Revisit when stable Solid publishes a Babel 8-compatible preset.
Client-heavy compiler/proof changes belong to the independent compiler owner.

## Scope and integration

Owned image changes cover Astro, Express, Next.js, Nuxt, React Router, SvelteKit
(both Dockerfiles) and TanStack Start. Framework dependencies, APIs, templates and
lockfiles stay as already merged. Express's htmx ADD input is unchanged.
For the htmx owner's combined retake, the fullstack Express runtime proof is bound
to the Express directory content identity below: Node 26.13.1 with the Bookworm digest above, native Express sources
unchanged, and the existing htmx 2.0.11 ADD/checksum. It does not certify the parent's
newer htmx 4 input. The owners must combine those inputs and retake native proof
without changing CSP, boost controls or the existing gates.
Eligible helper pins were updated in catalog, JSON API, marketplace raw contracts,
live, nodelay and fullstack diagnostics. A focused test checks exact digest references
in every owned application stage and eligible helper.

Other owners must reconcile these discovered old pins; they were not edited here:

| File | Existing input | Owner boundary |
|---|---|---|
| `bench/fullstack/droplet.mjs` | `node:24-bookworm-slim` for the browser item API | Cloud owner |
| `bench/fullstack/apps/django/qualify-production.mjs` | `node:24-bookworm-slim` for upstream | Server owner |

The search also covered `bench/workloads/cloud-*.mjs`, `droplet.mjs` and
`isolated/**`; no additional literal Node image pins were found there at the base.
Those paths and all other server/.NET/Rust application subtrees remain untouched.
Historical result files are not refresh targets. The descriptive Node 24 references
in the fullstack and JSON API READMEs remain an integration documentation follow-up.

The two shared `builds.mjs` recipe pins now use the same exact Bookworm reference.
Only those two string values change in that file. No Rust recipe, dependency/build
command, htmx input, registry, root package or CI configuration changes here.

### Deferred parent integration

The separate twelve-path companion patch remains in the original author worktree
for parent integration. It covers the parent's newer native live Express port,
Express/Bun deployment pin and newer helper runners/tests, which are absent from
this main-line base. Neither that patch nor any parent ancestry is included here.
Its native live smoke and deployment identity checks remain separate author-lane
evidence, not qualification of this release or of the complete live/deployment
scenario matrices. Combined htmx 4 and client-heavy compiler proof remain separately owned.

## Verification

The following native production/build/browser results are retained author-run
evidence, not new runs on the release commit. Their source content is mapped below;
release preparation separately reruns root, recipe and native unit checks. No Node 24
application build or old-image qualification was repeated. The host-side checks and
actual application containers report Node 26.13.1. No load or performance ranking is
claimed, and no historical evidence is rewritten.

### Source identity mapping

`git-tree:` identifies a directory's Git content object, not a private commit or
an image. Each application directory, including its manifest, lock, Dockerfile,
native source and local tests, was compared byte-for-byte with the frozen author
inputs before release preparation. All seven matched. These identities will be
reachable as source directories in the release, without importing author history.
The image identities bind the earlier actual production runs, not rebuilt images.

| Application directory under `bench/fullstack/apps/` | Source identity | Earlier production image identity |
|---|---|---|
| `express` | `git-tree:91f4af663a99cb746f3e5248aca100be101c330f` | `sha256:277a8f2998611010bf2712660aaabb76dd8135a9d7a7a3a6916c63c6ee2726ea` |
| `astro` | `git-tree:e79152f96f1b0d5382935e313255f3823130ec34` | `sha256:08d2c2fa66dddb1aa97a11903d5c17b7d8d5c8fb4c89312f48ee79da00c0caa5` |
| `nextjs` | `git-tree:2ed621c6c21a44f6895ec436ddbb10e482998250` | `sha256:36c5ca88b994e6b4685b638235b546d028fdaa0ee71652a25aaa662114b2d37e` |
| `nuxt` | `git-tree:533d2f5faa585a068ee26833575d91ac686d9b1f` | `sha256:f5fdbc9d3ac72edb1f02ab22458ec5e2b9beea1611cc21d0d1fbfeaeabfd461d` |
| `react-router` | `git-tree:70c5bb54f6933b4d7af388060b775c2eca39e07e` | `sha256:409b2d14147e4cdd2ff5870f12a93cc4082edd48226adbe9bb2e21f8cf75f0d4` |
| `sveltekit` | `git-tree:518a1fa6998cf540c2bc9c39e5ce9e4deabd79bd` | `sha256:4f86fa6501ac2151b2a4a69b35826a0afdeb116bd61d3408ac474bc25e05527a` (marketplace Dockerfile) |
| `tanstack-start` | `git-tree:4f6a669c7a6cb75f29f6e1b07675e305a4d7f413` | `sha256:fb839cb6ade76f47bbec9646bb9b63d19ffc14bec74c9fbf0621c0eeba8c66e3` |

The complete unchanged browser directory is
`git-tree:e8e1ffff5e3612e1df5f0f25bfdabb32eff666aa`. The native oracle and both
source implementations were also checked identical:

| Path | Content identity |
|---|---|
| `bench/marketplace/check.mjs` | `git-blob:6ea95a606b513723cc20d67a151c90734d52fe9c` |
| `bench/marketplace/fixtures.mjs` | `git-blob:7e103569d08693c630281996d0961f89dcebcbc7` |
| `bench/marketplace/upstream.mjs` | `git-blob:06be5d7dee25de0889651ee63ea6152e87bd44a3` |

Original local build logs, original failure logs, complete retake receipts and
browser outputs are preserved in the author worktree. They have not been moved,
rewritten or relabeled. Equality of these inputs is not a full rebuilt-release
qualification, performance comparison, independent review or proof of the deferred
parent patch. The existing SvelteKit legacy Dockerfile built separately; only its
marketplace image was used by the retained marketplace browser proof.

### Native checks

All eight production Dockerfiles built successfully on the exact new Bookworm image:
Express, Astro, React Router, both SvelteKit Dockerfiles, Nuxt, TanStack Start and
Next.js. Builds used their existing native production commands, without template,
compiler or dependency changes. This is build evidence, not a whole-group qualification.

All seven application unit suites passed on Node 26: 100 tests, no skips. This includes
39 Astro/Nuxt/SvelteKit tests, 54 React Router/TanStack/Next tests and seven Express
tests in its real production image. Native source reads, locale formatting, alert
stores, exact cents, invalid writes, redirects and deadlines retain their existing
assertions. No framework API migration was needed by these checks.

The independent, unchanged `bench/marketplace/check.mjs` oracle was run against
each actual production image with both deterministic fixtures and a real independent
HTTP source. Each complete app/source case checks 500 canonical numeric JSON records,
264 pages and 12 locale/device/JS profiles, including valid and invalid alert forms.
The six component-framework apps additionally run their unchanged
`alerts-http.test.mjs` and `alerts-browser.test.mjs` against each source, including
independent cookie-jar readback and JavaScript-on/off forms. SvelteKit parity uses its
existing separate marketplace Dockerfile/origin, not a changed legacy origin.

Three first attempts failed and remain failure evidence, not silently converted passes:

1. Astro/fixture returned `TypeError: fetch failed` before browser parity. Its server
   log showed normal startup. A fresh complete case, on the same image and with the
   unchanged oracle/alert suites, passed all 500 records, 264 pages, 12 profiles and
   nine native alert tests. The original transport failure was not diagnosed further.
2. React Router/API failed the browser oracle at the French invalid-price POST with
   JavaScript disabled. The captured response was 200 and the visible message was
   `Saisissez un prix cible supérieur à zéro.`, but the POST/navigation observation
   still failed. A fresh complete case on the same image passed all 500 records,
   264 pages, 12 profiles, upstream freshness/failure probes and nine native alert
   tests. The first wrapper did not retain the underlying error cause; no root cause
   or flakiness fix is claimed. No timeouts, assertions or gates were weakened.
3. Next.js/API failed at the German JavaScript-disabled invalid-price POST. The
   response was 200 and contained `Geben Sie einen Zielpreis über null ein.`, but
   the POST/navigation observation failed. The original wrapper did not retain
   the underlying error cause. A fresh complete case on the same image passed all
   500 records, 264 pages, 12 profiles, upstream freshness/failure probes and nine
   native alert tests, without changing assertions or timeouts. No root cause or
   flakiness fix is claimed.

The original 14-case matrix finished with eleven passes and three failures. All
three separate full-case retakes passed. A separate result audit checked each
retake's image ID against its failed original and required all 14 distinct
app/source pairs to report Node 26.13.1, 500 records, 264 pages and 12 passing profiles.
These completed cases total 7,000 canonical JSON comparisons, 3,696 pages and 168
profiles. This is not a clean first-pass matrix or a diagnosed flakiness fix.

| Application | Fixture case | Independent HTTP source | Native alert tests across both sources |
|---|---|---|---|
| Express | Pass | Pass | Covered by the oracle and seven separate unit tests |
| Astro | Pass on complete retake | Pass | 18 passed |
| React Router | Pass | Pass on complete retake | 18 passed |
| SvelteKit marketplace | Pass | Pass | 18 passed |
| Nuxt | Pass | Pass | 18 passed |
| TanStack Start | Pass | Pass | 30 passed |
| Next.js | Pass | Pass on complete retake | 18 passed |

The unchanged component-framework alert suites therefore passed 120 tests, with no
skips. TanStack has 15 tests per source, including its existing HEAD/method guards;
the other five have nine per source. This count was checked from the native suite
outputs, not assumed uniform. Original failure JSON, server logs, retake results,
build logs and the separately checked result audit remain local verification receipts.

### Browser compiler checks

The unchanged, installable browser lock passed `npm ci`, and its full build passed
under Node 26.13.1, including real Rust generation and all Solid/Remix/React/Svelte/Vue
client, server-rendered and dashboard variants. This validates the retained Babel 7
configuration only, not the blocked Babel 8 target. No compiler adapter or client-heavy
producer/verifier was edited.

1. `list-check.mjs`: 3,000 random edits, zero failures.
2. `view-check.mjs`: 3,000 random edits, zero failures.
3. `state-check.mjs`: all checks passed.
4. `run.mjs --iterations 1 --rounds 1`: all nine default candidates, all 12 operations
   each, zero page/console errors and all existing DOM assertions passed. Existing
   per-operation iteration overrides and warmup were retained.
5. `ssr.mjs --loads 1`: all eight candidates, 1,000 rows at ready, zero rows added or
   removed, zero errors; existing interaction assertions passed.
6. `dashboard.mjs --iterations 1`: all eight candidates, zero errors and existing
   dashboard assertions passed.
7. Browser `npm audit`: zero findings.

Saved JSON outputs were parsed separately to assert candidate counts, operation
counts, zero errors and SSR row conservation. These are shared-host correctness
diagnostics, not performance measurements or client-heavy qualification.

### Retained helper checks

1. Focused exact image-pin tests: two passed, no skips.
2. Catalog/JSON API/shared-build regression run: 133 tests, 129 passed, two failed,
   two skipped. Both failures were the author lane's then-parent-owned Node 24
   recipe mismatch, now corrected by this release's two authorized pin edits.
   The skipped checks are the opt-in Linux owned-container cleanup and native
   systemd syntax validation, not silently counted as passes.
3. Marketplace regression run with the new pin tests: 186 tests, 183 passed,
   zero failed, three skipped. Skips are remote-shell/systemd native syntax, the
   opt-in real k6 mock producer, and Windows SIGHUP. Unit mocks are not native image
   qualification or fabricated workload evidence.
4. The exact pinned Alpine helper image was pulled and actually reported
   `v26.13.1`; production app containers use the verified Bookworm image.
5. Author-lane documentation/link and design-reference checks passed after its evidence update:
   80 Markdown files, 1,710 table rows and 607 relative links; 192 design citations
   of 82 items and 365 citations of 186 commits.

### Focused release checks

The two shared Node recipe pins are reconciled with all eight production Dockerfiles.
Fresh checks against this focused release's exact inputs used Node 26.13.1:

1. Root `npm run check`: 211 tests, 210 passed, zero failed, one skipped. The skipped
   hardening observer requires `/proc/net/tcp`; it is not counted as a pass.
   TypeScript, minified runtime freshness, wire/event/OpenAPI/formatter checks,
   documentation/Choices/design citations and every subsequent root test stage passed.
2. Focused recipe/pin tests: 21 passed, zero failures or skips. The two previous
   shared-recipe failures are resolved without changing assertions or other recipes.
3. Current native unit checks: 128 passed, zero failures or skips. These comprise
   39 Astro/Nuxt/SvelteKit tests, 54 React Router/TanStack/Next tests and 35 Express
   tests. Express includes its native socket parser timeout/disconnect checks in
   both production profiles and its trace-context checks, not only its seven
   marketplace tests. Expected native timeout diagnostics were emitted by those
   lifetime tests; the complete suites exited successfully.
4. Scope/content audit: exactly 23 changed paths, the 22 authorized imports plus
   `builds.mjs`; that file differs only by two exact Node image strings. All seven
   application trees, the browser directory and the three oracle/source blobs
   match the retained author inputs. The source/image identity table was checked
   against the original results, not inferred from matching version labels.

The retained native matrix above is not relabeled as a fresh run. No production
image was rebuilt during release preparation, no old-runtime matrix was repeated,
and no new browser or full-group qualification is claimed for this release.

The first root check passed TypeScript but stopped at runtime-build dependency
resolution because the shared dependency directory lacked `terser`.
The unchanged root lock was then installed into this
release worktree for a fresh complete check; no root dependency version was edited.

The complete CONTRIBUTING framework/example battery, before/after performance work,
companion-patch runner qualification, independent review and release integration
are not completed by this bounded lane. No cloud,
push, pull request, merge, root/CI edit or other owner's application edit was made.
