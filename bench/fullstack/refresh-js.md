# JavaScript benchmark dependency refresh

Checked 2026-11-13. Authored on the unpublished grouped integration branch.
Fetched and compared upstream: `f12d3daa324644c1fc882a5d994408d774cbb58e`.
These are new comparison inputs, not a rewrite or requalification of historical rounds.

## Versions

Versions and engine/peer constraints were read directly from the official npm registry's
`/<package>/latest` metadata and package version documents, not inferred from issue text.
The Babel selection uses the `v7` dist-tag, not the default Babel 8 tag.

| App | Exact direct framework/compiler pins |
|---|---|
| Astro | `astro` 7.4.11, `@astrojs/node` 11.1.12 |
| Next.js | `next` 16.4.6, React/React DOM 19.3.1 |
| SvelteKit | `@sveltejs/kit` 3.2.0, `@sveltejs/adapter-node` 6.0.2, `@sveltejs/vite-plugin-svelte` 7.3.1, Svelte 5.57.3, Vite 8.3.8 |
| TanStack Start | `@tanstack/react-start` 1.169.5, `@tanstack/react-router` 1.170.46, `@vitejs/plugin-react` 6.3.0, `nitro` 3.0.261103-rc, Vite 8.3.8, React/React DOM 19.3.1 |
| Nuxt | Nuxt 4.6.4, Vue 3.5.45 |
| React Router | all four `react-router`/`@react-router/*` packages 8.5.1, Express 5.3.0, React/React DOM 19.3.1, Vite 8.3.8 |
| Browser/client compiler inputs | Remix 3.2.0, Solid and `babel-preset-solid` 1.9.19, Svelte 5.57.3, Vue 3.5.45, `@babel/core` 7.29.13, React/React DOM 19.3.1, esbuild 0.28.2 |

Primary version documents include [React Router](https://registry.npmjs.org/react-router/8.5.1),
[React Router Express peers](https://registry.npmjs.org/@react-router%2fexpress/8.5.1),
[React](https://registry.npmjs.org/react/19.3.1),
[Astro](https://registry.npmjs.org/astro/7.4.11),
[Next](https://registry.npmjs.org/next/16.4.6),
[SvelteKit](https://registry.npmjs.org/@sveltejs%2fkit/3.2.0),
[TanStack Start](https://registry.npmjs.org/@tanstack%2freact-start/1.169.5),
[Nitro](https://registry.npmjs.org/nitro/3.0.261103-rc),
[Nuxt](https://registry.npmjs.org/nuxt/4.6.4),
[Remix](https://registry.npmjs.org/remix/3.2.0), and
[Babel 7](https://registry.npmjs.org/@babel%2fcore/7.29.13).

## Supported Choices

React Router's official [Node custom-server template](https://github.com/remix-run/react-router-templates/blob/067adb378a00a4c2ceb71934d5e8901d0e87c256/node-custom-server/package.json)
selects Express `^5.2.1`; its current stable resolution is 5.3.0. The adapter uses
`app.use(handler)`, matching the template's production dispatcher rather than Express 4's
unqualified `app.all("*")`. Native framework rendering, loaders, actions, enhanced submissions,
and no-JavaScript form posts are retained. No logging or request-policy normalization is added.
The proposed `/upgrading/v8` documentation URL returned 404; the published package peers,
official template and real build/runtime checks are the compatibility evidence instead.

The existing supported Node 24 image line is retained; a suite-wide Node LTS/image decision
is not part of this lane. Validation used Node 24.22.1 and npm 11.19.1. React Router 8 requires
Node >=22.22 and React >=19.2.7; Remix requires Node >=24.3. The selected configurations meet
those constraints. Nitro remains a prerelease because this app already uses the `nitro/vite`
integration, whose published current version remains an RC. This is not a new stable-Nitro claim.

The six refreshed full-stack apps now have npm v3 lockfiles. All seven Dockerfiles for them, including the
separate SvelteKit marketplace Dockerfile, copy that lock and use `npm ci`. The existing browser
lock is refreshed with npm; no lock entries or integrity values were invented by hand.

Express's already-current direct pins are unchanged. A follow-up also commits its npm v3
lock and uses `npm ci` in its Dockerfile and build recipe. Its fresh production image passed
all 35 existing marketplace, request-lifetime and trace-context tests on one CPU and 1 GiB,
with no skipped cases. The locked npm audit reported zero advisories. The image's lock hash
matched the committed file: `978b8b4d1b09bc61f5cfdafafa33ab104c3e3ae3ffe5525cd022583b7d4eff09`.
Its measured runtime was Node 24.22.2, with Express 5.3.0 and EJS 7.0.2. An auxiliary
metadata probe first failed because EJS does not export its package.json; reading that file
directly then confirmed the versions and lock hash. Neither probe is benchmark timing.

The [Babel advisory](https://github.com/babel/babel/security/advisories/GHSA-4x5r-pxfx-6jf8)
is fixed in 7.29.6 and later; current-line 7.29.13 is selected without a Babel 8 migration.
Remix's `@remix-run/test` 1.1.0 still requests esbuild `^0.27.1`, which resolves to vulnerable
0.27.7. A narrowly scoped override reuses the direct esbuild 0.28.2 pin for that test package.
The [esbuild advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) names 0.28.1 as the
first patched release. A fresh install resolves one deduplicated 0.28.2 and browser audit is clean.

## Verification

Functional checks run on the shared development workstation are not benchmark speed evidence.
No generated bundles, screenshots, timing results or saved captures are included in this change.
The independent browser-proof work and client-heavy producer/verifier files are not changed.

All six `npm ci` installs and native production builds passed. Unit suites passed with no skips:
Astro 13, Next.js 26, SvelteKit 13, TanStack Start 14, Nuxt 13, React Router 14.
Built Astro and SvelteKit fixture/HTTP route suites passed 3 tests each. Nuxt's built-route and
source-failure suites passed 7 tests. React Router's built-source/action/revalidation suite passed
8 tests, including successful POST followed by failed GET revalidation.

The unchanged marketplace oracle passed for every app with both fixture and independent HTTP
sources: 500 canonical JSON records and 264 page checks across 12 locale/device/JS profiles
per app/source. All six existing `alerts-http.test.mjs` and `alerts-browser.test.mjs` suites
passed against each source, including valid/invalid submissions, independent cookie-jar
readback, ordering, exact minor units, and enhanced versus document POSTs. No app was filtered.
The aggregate is 12 successful app/source matrices, 144 browser profiles and 3,168 page checks.

The unchanged cross-app `nextjs/alerts-boundary.test.mjs` passed 16/16 with no skips. Its
SvelteKit server uses port 20133, so that check requires a build with
`BENCHMARK_ORIGIN=http://127.0.0.1:20133`; the first run against the legacy-origin artifact
failed CSRF with 403 rather than the expected 500 and timed out after navigation. Rebuilding
for the test's documented fixed origin resolved those failures without changing the test.
The ordinary full fixture/HTTP marketplace matrices used the unchanged legacy-origin build.

React Router's lock-consuming production Docker build passed. After readiness returned 200,
its native HTTP/browser alert suites passed 9/9 with no skips under one CPU and 1 GiB.
An initial invocation started the checks before readiness and got socket resets; the actual
ready-server rerun above is the passing result. The container was removed with volume cleanup,
and its temporary image was removed.

The browser build compiled every application using the final compiler dependency tree.
`list-check.mjs` and `view-check.mjs` each passed 3,000 random edits; `state-check.mjs` passed.
`ssr.mjs --loads 1` passed all eight default SSR variants, each with 1,000 rows retained,
zero added/removed rows and zero errors. `dashboard.mjs --iterations 1` passed all eight
default dashboard variants with zero errors. These small diagnostic runs are correctness
checks, not repeatable performance estimates. The first full nine-app `run.mjs` operation
pass reached every app but failed to save its output because its `--out` path was relative
to the wrong directory. The corrected `run.mjs --iterations 1 --rounds 1 --out <local-path>`
invocation completed successfully for all nine default candidates, with zero page/console
errors and every operation's DOM assertion passing. The saved results were parsed separately
to require nine operation candidates, eight SSR candidates and eight dashboard candidates,
and zero errors in every result. No candidates or benchmark operations were removed.

No compiler adapter or application behavior change beyond the Express dispatcher migration
was needed. Client-heavy's separate producer/verifier and fresh independent proof are not
certified by these checks.

## Integration Check

After installing the unchanged root lock's tooling locally, `npm run check` reached 210 tests:
208 passed, 1 failed, 1 skipped. The failure is
`bench/fullstack/builds.test.mjs:211`, which checks Dockerfile/recipe command parity:
`nextjs: its Dockerfile runs npm ci --no-audit --no-fund, which its recipe does not`.
The shared `node()` recipe in `bench/fullstack/builds.mjs` still names `npm install`.
The parent must reconcile that recipe with these lock-consuming Dockerfiles; this file is
outside the authorized lane. The root tooling, tests and registry are not altered to hide it.
The rest of CONTRIBUTING's framework/Rust/example-image battery and before/after performance
measurements were not run by this dependency lane. Fresh independent review is still required.
The staged change also passed the Markdown documentation and design-reference checks.

The release branch now aligns the shared six-app recipe with the committed Dockerfiles:
it uses `npm ci`, not `npm install`. All 19 build-recipe tests pass after that change.
The earlier failed check above remains the author-lane result, not a passing run.
On the narrow release branch based on merged main, root `npm run check` then passed:
209 tests passed, one platform skip, zero failures. No prior native qualification
receipt is relabeled as evidence for this release commit.

## Audit Limits

`npm audit` returned zero findings for Astro, Next.js, TanStack Start, React Router and the browser
tree. It returned 4 low findings in SvelteKit and 12 findings (6 low, 6 moderate) in Nuxt.
These counts include affected dependents, not that many independent root vulnerabilities.
The remaining roots are deepmerge, glob and minimatch in framework tooling dependency chains.
Current stable deepmerge is still 4.3.1, inside the reported affected range. npm proposes old
framework downgrades, not supported same-line fixes. No such downgrade, arbitrary runtime
dependency-major override, audit suppression or claim of full security qualification is made.
The specific Nuxt middleware-path and Babel findings that motivated this refresh are no longer
reported against the selected direct versions.

## Integration Boundaries

Only the six owned application directories, browser dependency manifest/lock, and this document
are changed. Root packages, CI, framework registry, native-language framework implementations,
client-heavy producer/verifier files and historical evidence are outside this lane.
The parent integration owns the shared changelog/guide updates and fresh independent review.
No cloud run, publishing, push, pull request or merge is performed here.
