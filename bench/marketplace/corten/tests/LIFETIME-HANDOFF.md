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

## Handoff limits

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
