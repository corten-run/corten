# Native Hardening

This group asks whether a deployment can serve an ordinary marketplace read before
and after a request hits a boundary. It is not a throughput ranking. Corten, ASP.NET
Core, Spring Boot, Next.js Pages Router, Django, Express, Gin, Drogon and Topcoat use
their native matched production adapters. Each runs directly and behind the reviewed
edge, with records read either from the fixture or over HTTP from a private upstream.
Keep these four configurations separate: a response from a proxy does not establish
how the application alone behaves.

| Phase | What to read from the result |
| --- | --- |
| Request timeout | Does an ordinary read complete before the client deadline when the private dependency is delayed? Can the next ordinary read return the right record? A client deadline does not prove the server enforced a timeout. |
| Request limit | How does the endpoint handle one complete request at the configured header boundary? Compare it with ordinary reads before and after. Acceptance is not an apparatus failure; rejection alone does not identify which process imposed a limit. |
| Dependency recovery | How long after the upstream restores its normal delay do five consecutive correct reads return to baseline latency? Fixture reads must not use the upstream and cannot establish a recovery time. |

The [native plan](plan.mjs) fixes the cases and budgets. The full matrix, including
missing native features, unsuccessful responses and failed checks, stays in the
evidence. Functional parity, the process inventory, terminal liveness and owned-resource
cleanup have separate checks. A bad control or missing receipt cannot be reported as
a framework failure. An unavailable measurement is not zero.

If ordinary reads succeed but the deployment has no discoverable health endpoint,
its terminal liveness check is unsupported. A discovered endpoint returning an
error, a process observed to have stopped, or an incorrect follow-up read stays a
failure; a missing endpoint does not erase it.
If no candidate health path succeeds, a completed HTTP 5xx during discovery
is reported with its path and status rather than as an absent feature. A
confirmed failure before timing counts against the app, not as a timed result.

Qualification applies only to the checked features. The runner does not test
incomplete requests, connection caps, large bodies or server-enforced deadlines.
A passed row is not evidence that those protections exist.
Connection-flood resistance: not measured.

Use the [grouped benchmark procedure](../workloads/CLOUD.md) for an official round.
For a deployed-edge case, nginx accepts the public `localhost:8080` authority
and forwards the original `Host` and `Origin`. The app receives the exact
`MARKETPLACE_PUBLIC_ORIGIN=https://localhost:8080` configuration; native direct
preflight still reaches the app at `http://127.0.0.1:8080`. The proxy strips
client-supplied forwarding metadata about the public authority and scheme. It
does not translate `Origin` or provide the application's CSRF protection. This deployment
differs from r96, where nginx forwarded its internal upstream name as `Host`.
The Corten marketplace adapter also requires the exact configured origin on
alert writes to the public authority; its direct listener retains the native check.

Before a full rerun after a deployment change, a dedicated test host can exercise
one fixture case per app against the real TLS edge with the same qualification gates:

```sh
node bench/hardening/run.mjs w1 --build --out /tmp/hardening-edge-check --review edge-deployment-check --verify-case deployed-edge --verify-source fixture --verify-phase request-limit
```

This filtered run is diagnostic, not an official group result.

Before the first cell, the runner prepares its Node upstream, Playwright checker,
nginx edge and OpenSSL certificate images. It reuses successful local lookups
and otherwise makes one bounded pull of the same reference. The Playwright
reference follows the pinned browser-driver version. That container supplies
Chromium and its libraries; new dedicated Hardening cloud runs do not install
a second Chromium on the host. The runner records and
uses the inspected image IDs; failure here is an apparatus failure, not a
framework result. This setup does not warm any measured endpoint or alter the
request schedule.

Isolated grouped runs pin the service, upstream, optional proxy, apparatus and host
command to separate CPU sets. Replay checks live Linux cgroups for the service
containers and native probe at the two boundaries of the probe's work, including
the effective sets of occupied child cgroups. Setup and terminal helpers are
checked against their Docker launch receipts, not sampled as timed participants.
This is boundary evidence, not continuous monitoring of every process.
When replay compares inherited execution defaults, an omitted or null image
`Config.Entrypoint` or `Config.Cmd` must match an explicit null in the container
receipt. Explicit image values, including empty arrays, and commands supplied by
the runner must match exactly.

The Hardening binding includes every tracked input to each application's source
digest, even files under an app's `results/` directory if they are in its build
context. This does not change the archive recipe or which files it selects. The
Corten root archive still binds the full measured checkout, including its harness.
Other groups keep the ordinary source inventory. An all-group plan keeps a shared
source digest and records the full Hardening closure on its own binding; a dedicated
Hardening plan records it in both places. Existing reservations replay with their
pinned measured checkout.

Offline replay checks the saved native evidence; it does not run a new measurement:

```sh
node bench/hardening/verify.mjs bench/hardening/results/w1
```

The current archive schema is `native-hardening-run/v3`. The
[previous contract and qualification notes](https://github.com/corten-run/corten/blob/ab40c8b1d60ada54c33e959cae73f3ef8c1768f8/bench/hardening/README.md)
describe different traffic and have no compatible baseline here. Replay earlier
captures at their original measured commit; do not import individual cells into v3.
