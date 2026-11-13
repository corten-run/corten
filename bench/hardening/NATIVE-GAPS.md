# Native App-Owner Handoff

These are observations from clean, immutable native images, not inferred framework
limitations or default-tier results. App changes belong to their native authors;
the hardening driver does not install defenses or replace their server/renderer.
The representative is the existing `PROFILE=matched` production adapter. An
alternative needs its own native identity and the same qualification gates.

## Express

`bench/fullstack/apps/express/server.mjs` already selects matched Helmet,
compression, private caches, body limits and a native Node HTTP server with a
30-second header timeout and configured connection cap. Do not replace those.
It does not consume `HOSTS` or register a liveness endpoint.

The retained `w6/express/fixture/direct/oversized-requests/qualification.json`
reports exactly `host` and `live` missing. The unknown Host is answered 200; all
seven standard liveness paths are answered 404. Independent `native-controls.json`
confirms the missing allowlist and endpoint. This is missing production feature
work, not an apparatus error, unknown-as-pass or a short attack's timeout finding.

Native author requirements in `server.mjs`:

1. Enforce configured `HOSTS` for matched native requests, accepting legitimate
   configured names/ports while refusing unknown Host with 4xx. Preserve allowed
   JSON, pages, forms, assets and health behavior.
2. Add an actual liveness endpoint (prefer `/health/live`) which returns 200
   independently of API source availability, and preserve a negative health path's
   non-success response. Do not use a catch-all 200 or upstream-dependent readiness
   as liveness.
3. Verify real same-origin form handling through TLS deployment. The current
   `crossSite` comparison uses `req.protocol` and `Host`; the existing nginx
   benchmark profile rewrites Host to `fsw-target:8080` and terminates TLS. This is
   a deployment compatibility risk, not a measured Express edge failure yet. Do
   not remove Origin/Fetch-Metadata checks or forge a safe origin in the driver.

## Gin

`bench/fullstack/apps/gin/main.go` uses `gin.Default()` and `r.Run` with no matched
profile middleware/server branch. `Dockerfile` builds that same native binary;
there is no missed production-profile installer. Relevant native implementation
sites are `main.go`, `marketplace.go` (forms/routes), and `record_http.go` (JSON).
Keep native Gin/templ rendering and existing source bindings.

The retained `w8/gin/fixture/direct/connection-pressure/qualification.json` has
these twelve failed cells and exact required existing-contract predicates:

| Cell | Observed | Required |
| --- | --- | --- |
| pageHeaders | none | CSP, nosniff, referrer, frame protection, opener policy |
| pageScripts | no CSP | strict script/default CSP, no broad scheme/wildcard, unsafe eval or unqualified inline |
| permissions | no | nonempty Permissions-Policy |
| pageCompression | none | br or gzip when requested |
| bigBody | 200 | refuse a 3 MiB form field with 4xx/5xx or recognized refusal/reset; healthy recovery |
| jsonHeaders | none | same five security protections as pages |
| jsonCompression | none; none | br/gzip for br+gzip request, gzip for gzip-only request |
| host | 200 | unknown Host refused with 4xx |
| bigHead | 200 | refuse 64 KiB request header with 4xx or recognized refusal/reset |
| live | none | real liveness 200, independent of upstream; negative-path control |
| unfinishedHead | held 40 s | native 30-second header deadline closes within existing 35-second qualification allowance |
| connectionCap | served with 1050 held (200) | configured 1000-connection cap; healthy below 950 and after release, no service past cap |

These are genuine absent matched-profile defenses/configuration. The last two
are observed default Go server outcomes, not evidence that Gin cannot implement
them. Native `http.Server` limits, a counted native listener, Gin middleware and
bounded body parsing are app-owner work. Compression must remain native (Go gzip
is sufficient); a common proxy supplying absent app features cannot qualify the
direct representative. Existing private caching, CSRF refusal, JSON 404/405/HEAD
and native browser/content checks passed and should remain intact. Fixture
qualification does not cover API read-error/deadline features.

## Deployment And Acceptance

The unchanged existing nginx profile overwrites the client's Host and has its own
default header/body/deadline/connection behavior. Direct production qualification
cannot qualify this effective deployment. `deploymentQualificationVersion: 1`
runs the same `qualify()` predicates through actual certificate-verified TLS
clients and retains separate `edge-qualification.json`, edge native controls and
direct/edge browser receipts. Missing edge defenses are deployment outcomes, not
assumed native mechanism failures. A healthy native form is still mandatory.

The retained `w10/aspnet/api/deployed-edge/slow-bodies` observation (producer
`398b3482f`) has no missing direct ASP.NET production features. Effective TLS
qualification observes unknown Host 200 and an unfinished head still held at
40,070 ms. The cap probe establishes only 536/473 completed TLS handshakes within
its unchanged connection deadline, below the required 950. Its connection-cap
result is therefore inconclusive, not proof of an absent cap; do not enlarge the
deadline/quota or relabel it a pass. Exact per-probe TLS receipts are retained in
`edge-qualification.json.probes.jsonl`, including on qualification failure.

The additional bad-Host control in that capture remains inconclusive because
Node derived TLS SNI from the overridden HTTP Host and rejected the certificate.
The follow-up client fix explicitly retains the URL's certificate identity while
changing only HTTP Host, tested with actual ClientHello bytes and trusted/untrusted
TLS receiving controls. The original native receipt is not rewritten. Effective
qualification's separate TLS client already kept SNI independent, so its observed
unknown-Host 200 remains valid. No qualified edge performance is claimed.

For a bounded app-author regression, use a fresh local round, for example:

```sh
node bench/hardening/run.mjs w11 --review approved-native-app-change --build --verify-app express --verify-source api --verify-case deployed-edge --verify-phase slow-bodies
node bench/hardening/verify.mjs bench/hardening/results/w11
```

The unchanged full 216-cell execution, after author changes are committed, is:

```sh
node bench/hardening/run.mjs w12 --review approved-complete-group --build
node bench/hardening/verify.mjs bench/hardening/results/w12
```

An existing pinned dependency install can be supplied with `--node-modules PATH`.
Every cell starts fresh native processes and repeats production and complete
browser/content gates. The full matrix is a multi-hour operation, not a 216-times
13.5-second smoke test. Verification filters retain all other cells as `not-run`
and can never set `groupReady`. Missing production defenses do not exclude an app
from hardening observation or turn unqualified observations into numeric parity.

## Five-finding repair verification

Fresh `w11` was produced from commit `7b39c7438c07b05ca12729b96872e2a229e292a1`
with `semanticReceiptsVersion: 2` and `lifecycleVersion: 2`. Its command was:

```sh
node bench/hardening/run.mjs w11 --review user-authorized-five-review-repairs --build --verify-app aspnet --verify-source api --verify-case deployed-edge --verify-phase slow-bodies
```

Both direct and TLS marketplace browser gates passed 500 JSON, 264 page and 12
profile checks. Direct native production qualification passed. The effective
TLS deployment still reports `host`, `unfinishedHead`, `connectionCap`: unknown
Host now reaches HTTP and returns 200 (missing validation, not the old SNI error),
the unfinished head remains open at 40,023 ms, and only 641/472 TLS connections
complete within the unchanged cap-probe deadlines. The last is inconclusive,
not proof of a missing cap and not permission to enlarge its budget. Edge liveness,
liveness under upstream fault and API-source controls were observed/passed.

The actual timed cell recorded 12 established connections retained to client
release at 8,500.034-8,506.071 ms, with 19-23 actual trickles per connection.
Legitimate work completed 4/4 before, 13/13 during, 10/10 after, with exactly
27 observed upstream requests and 27 successful upstream answers. Terminal
application, proxy and API-upstream Docker states were running, without OOM;
native process inventories were 1 application, 2 proxy, 1 upstream processes.
The declared 1.5 CPU/1536 MiB native limits were verified against Docker, with
the injector separately limited to 2 CPU/1024 MiB. Event-loop maximum was
38.011 ms. These are bounded observations, not workstation throughput claims.

Raw verification passed, as did 34 adversarial mutations and all six focused
retained-evidence review regressions. The result remains one observed cell,
215 not run, `groupReady: false`, `numericComparisonQualified: false`. Native
cleanup recorded no remaining containers, volumes or command clients and no
failures. A separate final label audit also found zero owned containers, volumes,
networks and generated images.
No old `w9`/`w10` evidence was rewritten or qualified under the new producer gates.
`review-regressions.mjs` can replay the old bytes without upgrading a capture;
`adversarial.mjs` retains strict full equality against a current saved capture.

The five review repairs now check release/window drift, full trickle cadence,
600 ms completed-response deadlines, all service-critical terminal roles,
pre-reserved network ownership/reconciliation, and completed native HTTP failures
as target-functional rather than apparatus failures. An unacknowledged network
create failure/timeout remains explicitly uncertifiable cleanup, never an empty passing
cleanup receipt. Real-daemon cancellation controls use labeled empty networks
and an explicitly injected process SIGINT event; they are not native qualification.
Fresh independent review and the full selected matrix remain outstanding.

Terminal focused checks passed 30/30; combined hardening/workloads/production-
qualification/edge checks passed 284/284 with file concurrency enabled. The two
bounded real-daemon controls each removed their two labeled test networks while
preserving the differently owned same-prefix network until its own cleanup.
No native timing parameters or shared application files were changed.
