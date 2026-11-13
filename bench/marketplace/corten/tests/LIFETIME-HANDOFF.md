# Native lifetime follow-up

This is a separate follow-up to the merged native alert-state work. It changes
only the Corten marketplace and ASP.NET/Express benchmark apps and their scoped
tests/docs. No framework crate, other app, shared runner, workload oracle or TLS
proxy is changed. There is no parity runtime switch, retry, shared renderer,
cloud action, push or pull request.

## Native changes

- Corten preserves the existing whole-read bound and maps reqwest timeout errors
  at both the header and body read to native gateway-timeout errors. Its existing
  drop-based client cancellation remains in place.
- ASP.NET uses request-timeout endpoint metadata, passes RequestAborted into the
  source and body reader, and disables response draining after cancellation.
  The Razor timeout policy writes a typed text response; API errors retain native
  Problem Details/status-code handling. Legacy item/catalog settings stay separate.
- Express passes an AbortSignal from the page response lifetime into the existing
  source fetch, aborts on disconnect and the existing matched timeout event, and
  guards the native alert commit. Its default page also has a bounded deadline.
- Matched Express consumes HOSTS through native middleware and serves an actual
  source-independent liveness route, without changing its existing limits or
  trusting forwarding headers. Default-profile host/health behavior stays separate.

## Regression driver

Run `lifetime.mjs` from the repository root as documented in the parent README.
It starts the actual existing native images, not substituted apps. `full` covers
both profiles, all locales, JSON, held headers/bodies, actual client aborts and
native form lifetimes. `posts` first establishes an accepted native session and
checks unchanged independent readback after failed lifetimes, then one successful
recovery append. `deadlines` additionally records/validates deadline content types.

The raw observations and native image/commit identities are local ignored files
under this directory's `results/`. Retain failures as well as passing captures:

- `before-corten-1794530721807/summary.json`
- `before-aspnet-1794530432939/summary.json`
- `before-express-1794530413646/summary.json`
- `after-aspnet-1794530662389/summary.json` (the cancelled-body draining regression)
- `content-type-before-aspnet-1794531608363/summary.json` (the empty untyped timeout regression)
- `final-corten-1794531113431/summary.json`
- `after-express-1794530742095/summary.json`
- `session-posts-corten-1794531405898/summary.json`
- `session-posts-aspnet-1794531385453/summary.json`
- `session-posts-express-1794531395743/summary.json`
- `typed-corten-1794531678112/summary.json`
- `typed-express-1794531688439/summary.json`
- `typed-final-aspnet-1794531861988/summary.json` (typed responses pass, but three source-lifecycle bounds fail; this is not a passing run)

Express's separate record-JSON regression evidence is under
`bench/fullstack/apps/express/tests/results/after-1794531278706/`. Its `--quick`
run checks both sources/profiles, native record JSON and errors; the lifetime
driver, not that quick option, supplies deadline/disconnect evidence.

## Original checkpoint limits

Corten and Express each passed the full scoped lifetime driver, the established
session POST checks and the typed-deadline checks. ASP.NET passed an earlier full
run after response draining was disabled, and its established-session POST checks.
Its final typed-response run has three failures: a default POST deadline and a
matched GET caller abort left one upstream read pending at the observation bound;
a matched stalled-body caller abort closed just beyond that bound. No upstream
completed successfully in those failed operations. The final run occurred while
another local verification setup was active; that does not establish a cause or
excuse the failures. Retain it as failed evidence, not native parity qualification.

Focused suites passed: Corten's eight Rust tests, scoped rustfmt/clippy, ASP.NET's
fourteen native tests and Express's seven native tests (including HOSTS/liveness).
Express's quick JSON regression driver passed all its checks. The Windows root
tooling check failed in WSL shell tests. Linux retries encountered setup problems;
the last source-copy attempt was stopped for the requested parent checkpoint.
There is no passing root-wide verification claim.

The socket checks are local correctness and waiting-time evidence, not calibrated
CPU/throughput measurements, complete mixed-oracle captures or group qualification.
Use the unchanged integration/native runner for those gates after landing this
follow-up. No success declaration or runner-side adapter supplies missing behavior.

The current TLS edge rewrites the public Host and terminates HTTPS without an
authenticated public-origin contract. An external HTTPS Origin against that
internal Host remains forbidden; native HTTP tests also verify that forwarding
spoofing cannot bypass this. The shared edge owner must resolve deployment
semantics. This lane does not weaken CSRF or enable blanket proxy trust.

An independent review and the full framework release/MSRV/example-browser matrix
remain integration work. No child agent was started, as requested. The repository
changelog is outside this lane's file ownership; carry the scoped behavior notes
into it when integrating. Temporary native image tags, processes and containers
are removed after verification; the branch/worktree and raw evidence remain for
the handoff. Do not start the full workload matrix before a fresh independent
review, as requested at the parent checkpoint. The remaining ASP.NET cancellation
bound needs resolution before this lane can claim complete native lifetime parity.

## Slow-upload review repair

The fresh review of `cfa922e66` found two real unfinished-form failures. The new
raw HTTP upload diagnostic reproduced both on clean production images of that
commit: a genuine captured Razor antiforgery form, or Express's native form,
dripping at 1000 bytes/s had no response at 12.5 seconds in either profile.
Finishing the body then produced ASP.NET 504 and Express default 504/matched 503.
Those late responses are failures, not native deadline passes. Baseline receipts:

- `slow-before-aspnet-1794533910250/summary.json`
- `slow-before-express-1794533920411/summary.json`

ASP.NET now makes the first native URL-encoded form read before MVC antiforgery,
using FormPipeReader with RequestAborted and the existing native form limits and
encoding rules. Request.Form caches the one collection for both antiforgery and
the handler. FormFeature.ReadFormAsync(token) itself aborts HttpContext on token
cancellation, which would prevent a native HTTP timeout response; no antiforgery
filter is disabled. Middleware is scoped to the actual Marketplace Razor endpoint.
Other form encodings retain their existing native reader, not a newly claimed
deadline repair.

Express now writes the native 504/default or 503/matched response while the body
is unfinished, then destroys IncomingMessage after response finish. Its actual
raw-body parser observes request.aborted and removes its data reader; the parser
callback cannot resume routing after cancellation. A focused native test verifies
that teardown in both profiles, with real ten-second timers, not fake clocks.

API deadline assertions now require JSON media and a valid error object: a
nonempty JSON error string, or Problem Details with the HTTP status and a nonempty
title. HTML/plain media, empty/invalid JSON and unrelated JSON values fail the
negative-contract unit test. API probes explicitly request application/json.

The expanded full driver passed 70/70 for each app on production builds from
`cfa922e66` plus the recorded dirty input manifests, all three locales and both
profiles. Each app had 22 real source-request caller aborts and 22 source
deadlines, with exactly requests=1/completed=0/cancelled=1/pending=0 per operation.
The real caller abort still occurs 50 ms after observing the source request; the
500 ms cleanup bound is unchanged. Measured maximum source cancellation times
were ASP.NET 148.614 ms, Express 34.371 ms and Corten 41.682 ms in these runs.
Receipts under this directory's ignored results folder:

- `repair-full-aspnet-1794534333721/summary.json` (70/70)
- `repair-full-express-1794534297430/summary.json` (70/70)
- `repair-full-corten-1794534520485/summary.json` (70/70)

The six unfinished-upload deadlines per app returned ASP.NET 504 at measured
10,011.451-10,069.271 ms; Express 504/default or 503/matched at
9,996.653-10,025.222 ms; Corten 408 at 30,003.056-30,018.522 ms. Corten's native
30-second body policy is unchanged, not reduced to ten seconds. Native socket
closure followed response headers by at most 3.414 ms in these upload runs.
Each unfinished upload started zero source requests, left the established alert
session unchanged and allowed a subsequent accepted POST to append exactly once.
All API source deadlines had JSON error payloads: native Problem Details 504 for
ASP.NET/Corten; application/json 504/default or 503/matched for Express.

Build provenance records actual image IDs, commit labels and scoped input-file
hash manifests, not an inference from the driver's HEAD. All three full captures
have sourceInputsVerified=true. Subsequent production-source hash comparisons
matched every full-run input. After those runs, only test/provenance/docs changed:
the driver now pins launches to the inspected image ID and records helper hashes;
the build helper also labels dirty source. Those runner-only changes receive a
separate Express upload-baseline smoke, not another claimed full run. The native
parser teardown test was added after the full image build and mounted read-only
into that image for its two passing tests. ASP.NET's 14 native tests, Express's
seven existing native tests and the JSON negative-contract test also passed.
The final pinned-image/provenance smoke passed 6/6, with dirty-source labelling
and sourceInputsVerified=true, in `repair-pin-express-1794535047781/summary.json`.

The fresh review's ORIGINAL Corten matched de-DE stalled-source-body abort
failure (57/58, pending work still present at 500 ms) remains UNRESOLVED. Its 25
later targeted passes, reported maximum 34.7 ms, did not establish a cause or
resolve it. Neither does this new 70/70 run. Preserve that failed review evidence
and the original ASP.NET bound failures above as failures; no flakiness excuse,
relaxed bound or complete native lifetime parity claim is made here.

Fresh independent review is the next gate; no child agent or full mixed workload
matrix was started. Traceparent propagation requested for the marketplace source
is queued after this checkpoint, not implemented in this repair. TLS edge/CSRF
semantics and shared runners/proxies remain untouched.
