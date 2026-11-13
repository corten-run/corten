# Express on Bun: ordinary runtime alternative

This deployment experiment changes the runtime, not the framework. Both candidates
execute the root checkout's `bench/fullstack/apps/express/server.mjs`, its EJS
templates, Express JSON/form APIs, and its default or matched production middleware.
There is no `Bun.serve`, copied application, shared renderer, cached response,
preformatted fixture, transpilation or alternative package resolution.

`pins.json` pins Bun 1.4.4 and the Node 24 base by immutable registry digest, with
the platform and verification date. Bun's [Express guide](https://bun.com/guides/ecosystem/express)
documents ordinary Express execution; the [1.4.4 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)
and [release notes](https://bun.com/blog/bun-v1.4.4) identify the pinned stable release.
This does not imply all Node policies are implemented: Bun's
[compatibility document](https://bun.com/docs/runtime/nodejs-compat) records HTTP
server differences, including ignored server keep-alive settings. The checks below
are evidence for their explicit cases, not a blanket compatibility certification.

## Build and run

From the repository root, with Docker and the repository's Playwright installed:

```sh
node --test bench/deployments/express-bun/run.test.mjs bench/deployments/express-bun/regressions.test.mjs
node bench/deployments/express-bun/run.mjs local
```

`run(args)` is exported; `args` begins with the required round name. Options are
`--out <new-directory>` and `--deps-root <checkout-with-playwright>`.
No runtime/source/profile can be silently omitted.
There are eight cells: Node/Bun x fixture/API x default/matched. The image starts
with `node server.mjs` or `bun server.mjs`, without runtime optimization flags.

The Docker build context is the repository root; its specific dockerignore admits
only the native Express inputs and the identity inspector. Node and Bun are in
the **same immutable resulting image**, sharing one npm install, the native exact
direct dependency versions, and every installed file. Its generated npm lock,
dependency-tree hash, binary hashes, runtime versions (including ICU), source hashes,
base-image pins, output image ID and build output are retained. The upstream app
has no committed npm lock: transitive resolution can differ on a fresh build.
The recorded per-image lock and tree identify that resolution; do not compare
different resolutions as if the runtime were their only difference.

The runner always builds from this checkout. It refuses caller-provided images
and receipts: an untrusted image could forge its own identity inspector as well
as its metadata. Docker's content-addressed build cache remains usable, but no
earlier correctness result is reused. The standalone `build(out, task)` export
in `build.mjs` creates an image and writes `build.json`; its caller owns cleanup.
The runner removes the image it builds after the checks, including failing runs.
Identity inspectors have unique owned container names and explicit removal in a
`finally` block, including when the attached Docker CLI times out.

Each app has a one-CPU, 512-MiB, 128-PID budget, only a loopback-published port, and
a 180-second per-cell bound. The fixture upstream is local; no cloud service or
existing collector is contacted. One Chromium instance visits one page at a time.
This is correctness verification on an uncontrolled host, not throughput evidence.

## Evidence and limits

`result.json` has schema `express-bun-qualification/v1`, with source/build/browser
provenance, controls, all eight cells, pair summaries, failures and explicit gaps.
Per-cell JSON, container logs, `raw.ndjson`, screenshots and fixture files remain
in the output directory. Raw output contains real HTTP responses and browser DOM
captures, including failed probes. Synthetic session tokens are hashed in HTTP
header observations. The source tree must remain unchanged during the run.
Each cell's `.log` combines both Docker log streams; `.stdout.log` and `.stderr.log`
also retain the full streams separately, without trimming trailing bytes. Their
interleaving in `.log` is observation order, not an assertion about server write order.

Checks cover all 500 JSON records in each contract; source counters and mutation;
native HEAD/method/error/cache behavior; redirect and upstream failure rejection;
malformed and out-of-contract records; whole-read deadlines and real caller-abort
socket closure; cross-site writes; matched cache/security/compression; representative
catalog pages and filtering; marketplace pages in all three locales; native GET and
POST forms with scripts enabled and disabled; and persisted `/api/alerts` readback.
Fixture cells keep the controlled upstream unavailable (503) from before app startup
through all checks. JSON sweeps and each browser case additionally assert zero upstream
attempts, including non-record requests; a whole-cell check includes startup and forms.
An API relay that falls back to fixtures after a failed upstream request still fails.
Alert checks include exact minor units, invalid/rejected-write non-mutation,
caller-chosen-cookie refusal, independent sessions and concurrent established-session
appends. The store remains the native process-local store, not durable storage.

The shared record/browser modules are **offline oracles only**. They are not copied
into the app image. Additional malformed-source probes include Unicode scalar
robustness beyond the current shared record validator; failures are retained, not
silently called workload passes. Exact keys, requested IDs and unique marketplace row
IDs come from existing record oracles, but these malformed-source injections and the
apparatus's required 5xx rejection are not automatically common group requirements.
The parent must reconcile rejection policy across peers; this lane does not change apps
or shared contracts to impose stricter schemas on only one contender.

`functionalPassed` requires every explicit check to pass; equal failures do not
establish parity. `readyForMeasurement` and `readyForLoad` always remain false.
Independent source/serializer review, complete mobile/dark/style parity and all
production capability gates are still required. No audit is invented by this
apparatus. No load, startup or memory advantage is asserted. Standalone/bytecode
and machine-AOT are not candidates here; they need separate actual artifacts,
meaningful measurements and independent qualification before admission.

Parent integration: retain this as `express-bun-normal`, alongside the Node Express
baseline in the deployment catalog. Add the focused test command to the parent's
checks and bind any later group receipt to the full image/source/options/contract
identity. This narrower result is not a whole-group qualification or review receipt.

## Bounded regression probes

```sh
node bench/deployments/express-bun/verify-fixes.mjs regressions
```

This command accepts the same round/output/dependency-root options and always builds
the native image from the checkout. It is not the eight-cell qualification runner.
It checks a hanging named inspector's timeout cleanup, complete stdout/stderr logs
from a failing native process, and Node/Bun fixture claims against actual fixture and
API sources. Each runtime/source probe checks both 500-record JSON sweeps and native
catalog/marketplace browser forms without JavaScript. API-source negative controls
must be rejected as fixture claims. It retains `regressions.json`, raw output and
screenshots, removes owned containers/images, and reports remaining owned resources.
App budgets are one CPU, 512 MiB and 128 PIDs; each source probe is bounded at 120 seconds.
These are correctness regressions only, with no performance or candidate-readiness claim.
