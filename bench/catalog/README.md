# Catalog benchmark

A locale-neutral record-detail page, separate from the marketplace workload in
`../fullstack`. No currency, dates, counts, plural messages or localized numbers. The data is
strings only, and every app escapes those strings using its framework's ordinary templates.
The localized card-market example and all earlier benchmark results stay unchanged.

## Workload contract

`catalog-v1` has 500 records, `record_1` through `record_500`. Each record has exactly these keys:

```json
{
  "id": "record_1",
  "title": "Ridge trail",
  "subtitle": "Survey notes",
  "description": "A record with text, not display-formatted numbers.",
  "tags": ["survey", "outdoors"],
  "fields": [{"name": "Access", "value": "North gate"}],
  "related": [{"id": "record_2", "title": "Valley trail"}]
}
```

`GET /catalog/{id}` renders a fresh document for each request. It reads the record once, from
memory (`CATALOG_SOURCE=fixture`, `CATALOG_FIXTURE_PATH=/fixtures/catalog.json`) or from
`API_BASE/catalog/records/{id}`. In-memory records are parsed at startup, not each request.
The HTTP mode fetches and parses once per request, with no response or record cache. Unknown
records return 404; upstream errors are errors, not an empty 200. `GET /api/catalog/{id}`
serializes the same record through the framework's normal JSON support. It does not return a
pre-serialized body. No marketplace view-model conversion is in either path.

The stand-in upstream is Node's HTTP server: it answers with `Keep-Alive: timeout=5` and, on the
pinned Node 26, closes a connection idle for that 5 s keep-alive timeout plus Node's 1 s buffer
(observed at 5,999 to 6,045 ms after the last answer). A read written to a pooled connection as
the upstream closes it can fail in the send, before the upstream's handler sees it. That is a
possible mechanism for a failed upstream read, reproduced here only against a test double that
closes at 5 s; it is not a diagnosis of the saved r21 catalog or r27 marketplace failures, whose
cause remains unattributed. The Corten app and every fullstack app whose client would keep idle
connections longer (reqwest's default is 90 s) are configured not to reuse a connection idle 4 s,
a second under what the upstream advertises. Spring is the exception at 1 s, since the JDK client
drops an expired connection late, and Drogon and Django check the idle time when they take a
connection from the pool, so an expired one is skipped at checkout rather than closed at 4 s. The
full-stack [Caveats](../fullstack/README.md#caveats), item 5, list each client's setting.
`bench/fullstack/idle-close.mjs` checks that an image had dropped them when its probe requests
reached the upstream with every warmed connection idle 4.5 to 4.75 s (or closed under 4.75 s
idle before the probe) and nothing sent upstream since the warm-up, under the upstream's 5 s
close; it does not measure the configured 4 s itself. This is the pool policy alone: no retry, no
cache, and still one upstream GET per record
read. It is a correctness-only change to the timed request path: the apps' pool bounds, and the
class counters below, are timed inputs for groups measured from this point, with no performance
claim; their cost is not measured, and saved results are unchanged.

The stand-in upstream alone pre-serializes and UTF-8 encodes its records at
startup. Canonical record GETs reuse those bytes without URL parsing or an
asynchronous handler; other URL forms retain normal URL parsing. Controlled
overrides, pretty JSON, errors and exact per-record read counters still apply.
This reduces apparatus work, not the measured apps' fetch, parse, render or
serialization work. Explicit catalog-page group runs use two fixed request
workers and a coordinator in the existing upstream container, as described below.
Ungrouped runs and callers without `--fixed-workers` retain the single-process
upstream. Neither topology alone proves sufficient native capacity.

Every page uses the app's normal layout and the same `catalog.css`, with this content inside
`main` (framework-only wrappers and hydration attributes are not part of the contract):

```html
<article aria-label="Catalog record">
  <h1>title</h1>
  <p>subtitle</p>
  <p>description</p>
  <ul aria-label="Tags"><li>tag</li></ul>
  <form method="get" action="/catalog/record_1">
    <label>Field name <input name="field" value=""></label>
    <button type="submit">Filter</button>
  </form>
  <table>
    <caption>Record fields</caption>
    <thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>
    <tbody><tr><th scope="row">name</th><td>value</td></tr></tbody>
  </table>
  <nav aria-label="Related records"><ul><li><a href="/catalog/record_2">title</a></li></ul></nav>
</article>
```

Repeat tags, fields and related links in source order. Empty lists keep their containers.
`?field=prefix` shows only fields whose name starts with that prefix, case-sensitive, with no
locale comparison, trimming or case folding. The input retains the prefix. The form and links
work without JavaScript; each framework may enhance navigation in its usual way. The measured
unfiltered page renders every field, without hidden rows or pre-rendered HTML. There is no
benchmark-only fast path in the framework.

## Results

### Speed Configuration

Catalog is the lean rendering workload, not a production-hardening comparison.
The standalone Corten app builds without optional response compression (load
requests use identity encoding), and its exact `PROFILE=catalog-lean` sets the
handler deadline, header timeout and send timeout to `None` through the public
`App` configuration. The catalog runner alone selects `CATALOG_LEAN=1` at build
time to omit the app's default compression feature. The JSON API group shares
this source but retains its default compression-enabled build and blank runtime
profile, including the original timers. Its HTTP
source still bounds each upstream request to ten seconds. Error logging stays
enabled. Other Corten apps and the framework's production defaults are unchanged.

Axum/Maud uses its lean router here, not its `PROFILE=matched` middleware stack.
Corten still uses its normal typed routes, escaped `html!` templates, document
layout, assets and `req.page`: mandatory page security headers, cache metadata,
error handling and other built-in stages remain framework costs. All catalog-page
contenders must now serve their HTML documents with a common header baseline:
an enforced CSP restricting inline scripts; protection against cross-origin framing
(CSP or X-Frame-Options); `nosniff`; a referrer policy no looser than
`strict-origin-when-cross-origin`; same-origin opener isolation; and explicit
permissions and cache policies. This workload draws on the
[OWASP HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html);
the headers are a benchmark requirement, not a claim that HTTP mandates them.
Both data sources must serve these policies on the actual HTML response.
The correctness browser disables its HTTP cache for these visits so a
revalidated document's 304 fields cannot be mistaken for the headers of a
fresh 200 response. This does not change the app or the timed load generator.
Equivalent policies need not use identical header strings or send the same number
of bytes. This document contract adds no requirement to the JSON route and
does not require the matched profile's compression, deadlines or other middleware.
Earlier lean results did not check this baseline. Do not relabel them or attribute
an earlier throughput difference to headers without a separate measurement.

**Header-only control (not a group result).** On 2026-11-18, four alternating
off/on pairs exercised the same Axum/Maud release binary on Linux/WSL2, with
the catalog adapter from commit `af63d0eca73baa91daf8066e94491b6654b872fc`.
Each trial made 200 warmup and 2,000 measured serial keep-alive requests to
the same in-memory record. All returned the same HTML. Enabling just the page
headers increased the parsed header block from 101 to 604 bytes. The paired
increases in server-task hardware cycles per request were 15,835, 13,329,
71,996 and 23,590 (orders off/on, on/off, off/on, on/off). This checks that
the extra work is measurable on that binary; the spread and single-client
setup do not tell us how much it affects throughput or the gap to Corten.

An `unstaged` data route is not a substitute: its sandbox would disable the
catalog's working form. No output cache, pre-rendered response or framework
internal bypass is used. Both sources retain the complete page/JSON correctness
gate, browser checks, field filtering and fresh request-time rendering.

The runner selects `PROFILE=catalog-lean` for the registry's catalog-page
contenders in both correctness and timed containers. Other diagnostic adapters
retain their existing profile; richer group runners keep their production or
matched settings. A new ungrouped run that includes both checked and unchecked
adapters reports their rows separately; it is not a header-matched baseline.
This is one supported lean recipe per contender, not an
unbounded search across runtimes, compilers or framework internals.

| Contender | Supported lean configuration |
|---|---|
| Corten | No optional response compression or handler/header/send timers; normal page stages and error logs remain. The timed requests accept no coding and name no tag, so their pages carry no `ETag`. Only lean runs of commits from `2704dba9e`, which turned compression off for this recipe, to the one before `f93b94358`, which made a build without compression decide a tag as one with it does, hashed one for each page. |
| Axum + Maud | Lean router with document headers on the catalog page, without the rest of the matched production middleware. |
| ASP.NET Razor | Minimum request/response data rates unset; native Kestrel header/keepalive timers remain at their defaults after infinite timers caused early connection closure in Linux checks. Razor rendering, source failures and logging remain. |
| Express | Production EJS view cache; no ETag generation or HTTP header/request/keepalive timers; fresh response rendering remains. |
| FastAPI | Uvicorn access logging disabled; error logging, worker count, event loop and parser selection unchanged. |
| Gin | Release mode with `gin.New()` plus panic recovery, without the per-request access logger. |
| Drogon | Gzip/Brotli disabled; warning/error logging, release build and existing thread selection retained. |

These use public [Node HTTP options](https://nodejs.org/api/http.html),
[Kestrel limits](https://learn.microsoft.com/aspnet/core/fundamentals/servers/kestrel/options),
[Uvicorn settings](https://uvicorn.dev/settings/),
[Gin router constructors](https://github.com/gin-gonic/gin/blob/v1.12.0/gin.go)
and [Drogon configuration](https://github.com/drogonframework/drogon/blob/v1.9.14/lib/inc/drogon/HttpAppFramework.h).
Different stacks still retain different mandatory stages and transport behavior;
settings not safely supported as disabled stay unchanged. In particular, Uvicorn's
keepalive setting stays at its normal value rather than incorrectly treating zero
as an unlimited timeout. Raw container evidence and reports record the selected
profile; historical evidence without it is not relabeled.

Results measured before these settings changed retain their original settings.
The next measurement establishes the lean configuration; do not relabel earlier
numbers or attribute their gap to these settings without a matched A/B measurement.

No comparative results are published for this workload yet. Its first round establishes a new
baseline. Marketplace rounds `r1` through `r16` must not be described as before measurements of
this page, or mixed into a catalog trend. Framework production settings can still differ;
equal application work is not a claim that their middleware, hydration or transports are equal.

Generate a read-only report from a saved `summary.json`, including preliminary or failed runs:

```sh
node bench/catalog/report.mjs bench/catalog/results/c1/summary.json
node bench/catalog/report.mjs bench/catalog/results/c1/summary.json --commit FULL_MEASURED_SHA --require-complete
```

For a historical ungrouped round, the second command exits unsuccessfully unless all twenty apps,
all requested 64-user passes,
the per-app correctness evidence, canonical fixture identity, measurement configuration,
clean-tree provenance and cleanup succeeded. A new ungrouped run that mixes header
contracts fails this strict comparison even if every app finishes; use the grouped
catalog report for a header-matched comparison. Supply the full measured
commit, not a branch name. Reports include phase duration, warmup, fixed rate and CPU placement,
label partial pass counts and every app's throughput range, show Corten's CPU efficiency,
memory and latency, and flag underutilized app CPUs or busy single-process
upstreams. A successful correctness baseline is not proof the app saturated its CPU. Inspect
the raw artifacts and `host.txt` as well; the report does not collect results or delete a host.

Application logs preserve both stdout and stderr directly in each raw `app.log`, including
output larger than the command's bounded in-memory diagnostic tail. Command deadlines and
log-collection failures remain explicit failures; incomplete logs are not silently accepted.
This does not disable native access logging or change measured application settings.
When a detached app start or an application, startup or upstream log collection fails or
reaches its deadline, the runner saves a `catalog-command-failure/v1` receipt before it removes
the owned container: `app-start.failure.json` in the source or preflight folder, or
`<log>.failure.json` beside the partial log. A failed detached start (`docker run -d`) writes only
its receipt, with no log file: that command collects no logs. When a started app later fails its
startup check (not running, or no published port), the runner collects its logs into
`<container>-startup-<attempt>.log`, numbered per attempt, and a failure of that collection
writes `<container>-startup-<attempt>.log.failure.json` beside it. The receipt records the
Docker client's lifetime in milliseconds after spawn (first and last output on each pipe, client
exit, each pipe's close, when and why the runner stopped it, and what the stop signalled), and the
offset, bytes and SHA-256 of what the log collection appended, hashed from the closed file. A
container is read only when Docker names it exactly and it carries this run's label. Each command makes that
check once, and its receipt is bound to the result: a log collection reads logs by the ID it
resolved, and its receipt reads that same ID, never the name again. From `docker inspect` it
keeps the restart count and the state's status, running flag, exit code, OOM flag and start
and finish times; from Docker events since one minute before the command, each event's action
and time. It keeps no health-check output, labels or other event attributes. For a missing or
foreign container (application, startup or upstream) it keeps the command's own evidence and
the refusal and queries nothing; if the verified container has gone by the time of the
receipt, it records that and queries nothing else. A detached start has no earlier check, so
its receipt's one ownership check is also its state: that inspect is not repeated. Each probe
has a 10-second bound and a probe failure is recorded in the receipt. An output write error
after another stop was accepted is recorded as `outputError` and does not change the stop's
outcome. A Docker client that cannot be started fails with Node's spawn error (its `exit` has no
code or signal) unless a stop was accepted first; then that stop decides and the spawn error is
recorded as `spawnError`. Saving the receipt is best effort and never replaces the
failure, which still fails the run; nothing is retried and no command deadline changes.
Receipts cover the detached parity and preflight starts and these log collections, not the
measured cold-start create and start. Commands in a timed phase, such as k6's `docker start
-a`, take no receipt and do no receipt work: no lifetime record or clock, no receipt byte
count, no hashing, and no listener beyond their output, error and close. Their command path is
still not the one before receipts: each output chunk also passes an earlier-write-error check
and a receipt flag test, and command setup and settlement changed. Their timing effect has not
been measured.
A command succeeds only once its Docker client has exited and both of its pipes have closed,
so its output is complete, and nothing stopped it: a command stopped at its deadline or by an
interrupt fails whatever its exit code, cleanup commands included, and the first stop reason
decides which (an interrupt followed by the deadline stays an interrupt).
On Linux the client leads its own process group, and the runner signals that group only while
the client has not exited: Node has not reaped it, so its PID, which is the group's ID, is still
reserved. The stop sends SIGTERM to the group and, two seconds later if the client is still
running, SIGKILL. Each signal is checked and sent from an event-loop callback of its own, never
from the code that requested the stop: libuv reaps every exited child in one batch before it
reports any of their exits, so a stop requested from one client's exit callback could otherwise
see another client as unreaped after it was reaped. Once the client has exited the group is
never signalled again, because a successful probe cannot tell the original group from a new
one that took its number. This is a deliberate rule: a group member that ignores SIGTERM and
outlives the client is not killed. If it holds a pipe, the runner releases the pipes at the
bound and fails the command, recording
that the client exited while its output stayed open. Owned Docker containers are still removed
independently, so this does not leave a browser or k6 container behind. Nothing is signalled
for a client that had already exited before the stop.
On Windows tree cleanup is best effort: `taskkill /T /F` receives a bare PID and gets three
seconds to stop the client's tree. It is not run for a client that has already exited, and it
is abandoned at 4.75 seconds. If it fails, cannot start or takes longer than three seconds,
whatever its exit code, a client still running is killed through its own handle, and the
helper's outcome is recorded.
A signal that fails (to the group, to the client's own handle, or the helper's own kill) is
recorded and never ends the stop early: the first stop reason still decides the outcome, the
pipes are still released at the bound, and a helper still running then is abandoned without
holding the runner.
A process that left the group (a new session) or the `taskkill` tree, or a group member that
outlived the client, can still hold a pipe after the client exits. The runner does not stop
such a process: five seconds after the stop it stops reading, so the command settles as a
failure that says its pipes were released without end of file, instead of waiting forever. A
client that is somehow still running then is left running, no longer holding the runner, and
the failure says so.
Startup failures include the container's actual exit state and application log. A checker
failure without a valid record-response failure receipt retains its original diagnostic
(including browser/style assertions), rather than replacing it with a missing-file error.
Such failures remain incomplete and block timing; they do not become replayable negative
attempts or passing checks.

Grouped campaigns additionally use `verify.mjs FOLDER cN FULL_COMMIT`, run from a checkout of
FULL_COMMIT (for example `git worktree add --detach <dir> FULL_COMMIT`), to replay
`catalog-saved-evidence/v2`, `catalog-saved-evidence/v3` or `catalog-saved-evidence/v4` observations without running Docker, Git or a browser.
This schema requires the selected k6 image, platform and actual executable version;
older evidence is not retroactively assigned that identity.
The native producer preserves the fixture, checker receipts, native build/image
receipts, cold probe and container identity, k6 summaries, before/after cgroup
counters, raw Docker memory/CPU samples and a final owned-resource query. The
validator checks the complete registry matrix, phase clock windows, cumulative
counter and upstream-container identity continuity, and recomputes every saved metric
and aggregate. Truncated stats framing fails in the producer as well as replay,
preserving its raw bytes.
Exit 0 means native evidence replay passed; exit 2 means required
observations are missing; exit 1 means malformed or contradictory evidence.
For a gated negative attempt, the retained upstream and checker image references are checked
against the pins of the checkout that loads `verify.mjs`, and the k6 reference is checked wherever
k6 was recorded, so evidence measured before a pin moved fails from a newer checkout. `verify.mjs`
reports that refusal as it is: the pin it expected and the measured commit to verify from, never
the saved reference. Every other failure stays "native evidence invalid or contradictory".
Complete and timed evidence does not compare the upstream and checker references with the
checkout's pins; replay it from a checkout of its measured commit all the same.
This is not host-isolation or independent source-audit approval. Those remain
separate campaign gates. Old summaries remain reportable, but cannot acquire the
new raw proof retroactively; images not built in the native run are not qualified
by this validator.

Dependency input: this refresh moves the Corten app's brotli from 9.1.1 to 9.1.3 and zstd from
0.14.3 to 0.14.4, with other crates it shares with the workspace lock ([#1767 The catalog and marketplace Corten apps lock brotli 9.1.1 and zstd 0.14.3 behind the workspace lock, so those benchmarks time a compression stack CI no longer tests](https://github.com/corten-run/corten/issues/1767)).
Compare a new run with an earlier one as a changed dependency input: no speedup from the move was
measured, and r21 stays pinned to its recorded source, `4225a2837`.

The proposed [marketplace v2 contract](../marketplace/README.md) retains a richer app workload
while requiring equivalent request-time localization. It is groundwork, not a measured or
ready-to-run replacement for catalog or the historical marketplace suite.

## Running it

From the repository root, with the Node version in [`.node-version`](../../.node-version), Docker
and Playwright Chromium installed:

```sh
npm ci
npx playwright install chromium
node bench/catalog/fixtures.mjs
npm run check:catalog
node --test bench/catalog/check.test.mjs
node bench/catalog/run.mjs c1 --build --check-only
```

The hosted Catalog checks' runner steps use the exact Node in `.node-version`. The harness's and
the Gin, Drogon, Topcoat and Leptos cells' browser checks run in Playwright's image for the
`@playwright/test` version in `package.json`, with the Node 26 that image installs by major
version, which can differ in patch; their image step prints both versions in its log, or warns that
the image's version is unavailable when its bounded probe fails. The Nuxt cell launches that image
itself and does not print its Node. `runner.test.mjs`'s shell tests run the image steps, that probe
and the guarded check commands in bash; only the probe test also needs GNU `timeout -k`. A local
host without bash skips the shell tests, and one without GNU `timeout` skips only the probe test,
each with its reason; hosted CI always runs them.

The generator explicitly gives only its public synthetic `fixtures/catalog.json` mode 0644
and its `fixtures/` directory mode 0755, including when regenerating under umask 0077.
Non-root native image users can read the read-only mount without opening checkout parents,
results, campaign state or audit files. Gin's production image likewise makes only its
public static assets readable and their directories traversable before switching to `nobody`.

The default inventory is all twenty page apps in `fullstack/apps.mjs`, not its JSON-only
ASP.NET AOT app. `--apps corten,axum-maud` selects a subset for development. Each app is built
in its existing production image, except Corten's standalone `corten/` app, which uses the
local framework without the marketplace's localized model. Catalog image tags are
`cb-catalog-<app>` so they do not replace the marketplace images.

### Explicit catalog-page group

Image and checker-boundary projections retain optional Docker `Entrypoint` and `Cmd`
as explicit `null` when omitted. Image projection first requires a non-null, non-array
configuration object; malformed configuration cannot become null defaults.
Replay still requires the inspected image defaults,
the full native checker/upstream commands, and the exact effective executable/arguments;
an omitted observation cannot stand in for a required nonempty command.

```sh
node bench/catalog/run.mjs c3 --group catalog-page --build --check-only
node bench/catalog/run.mjs c4 --group catalog-page --build --passes 3
node bench/catalog/report.mjs bench/catalog/results/c4/summary.json --commit FULL_MEASURED_SHA --require-complete
node --test bench/catalog/group.test.mjs bench/catalog/runner.test.mjs bench/catalog/report.test.mjs bench/catalog/contract.test.mjs
```

`--group catalog-page` selects eight apps: Corten, ASP.NET,
Express, FastAPI, axum/Maud, Drogon, Gin and Proa. It cannot be combined with `--apps`; missing native
inventory entries fail selection rather than shrinking the group. No group is selected by
default, and this does not change the scheduled benchmark or historical twenty-app results.
The `json-api` group is not implemented by this option.
Historical group results replay against their original roster. Use their measured
checkout for strict qualification; they are not evidence for the expanded group.

**Proa admission pilot, 2026-11-27 (not a baseline).** The Proa 0.4.1 release
image passed the native checker in both modes: 120 page checks, 500 JSON
records and eight browser profiles per mode. For a fixture-only timing smoke,
the lean Corten build from `468264ace` and this Proa adapter each had one CPU
(same pin) and 1 GiB. A loopback client rotated records 1, 17 and 250 over a
single persistent connection, identity encoding, 60 warmup then 600 measured
GETs per pass, alternating adapter order over three passes. No request failed.

| Adapter | Successful requests/s, median [min, max] | p99 ms, median [min, max] | App CPU µs/success, median [min, max] |
|---|---:|---:|---:|
| Corten | 74 [51, 138] | 51 [24, 80] | 617 [482, 739] |
| Proa | 76 [41, 77] | 62 [50, 73] | 656 [632, 813] |

The shared host and serial client did not establish capacity: variation between
passes was larger than the difference between medians. Include Proa as a native
SSR peer, not a new speed leader. These checks do not qualify it for the localized
marketplace; no marketplace port or extra scheduled case is proposed.

Both fixture and API sources retain the full native **page AND JSON correctness gate** below,
including all eight browser profiles and upstream error/uncached-read checks. Only **page**
responses are timed, including cold start, warmup, fixed-rate, 64-user and 256-user phases.
There are no JSON timing runs. These stronger correctness gates are not a JSON-group result.

Group summaries use `catalog-group-results/v1` and a `catalog-group/v1` descriptor from
`group.mjs::groupDescriptor("catalog-page")`. It records the registry schema, exact contract
SHA-256, ordered apps, cases, sources, timing targets and stronger correctness targets.
Qualification captures (`<source>/<app>/qualification.json`) and per-pass timing evidence bind
the app, source, payload and targets to the immutable image ID. Raw native `checks.json` and
phase artifacts remain unchanged. After cleanup, group runs also capture `commitAfter` and
`dirtyAfter`; a changed HEAD or dirty tree fails the run. Reports require the same HEAD and
clean tree before and after the run, plus the canonical fixture hash. An image ID identifies
the image used, not proof of its source revision when reusing an image without `--build`.

The report accepts a complete group comparison only with the full roster for that contract, both sources, exact
qualification/timing identities, every requested pass, valid cold/warmup and all three load
phases. Every saved phase aggregate must exactly match the native aggregation of its individual
runs, including collected and requested pass counts; missing, altered or extra aggregate fields
cannot establish a complete comparison. Missing evidence is incomplete; contradictory contracts,
duplicate passes, unexpected apps/sources/targets or wrong identity bindings are rejected. Group reports have page columns
only and disclose the stronger correctness gate. Ungrouped CLI defaults, summary shape and
historical full-baseline validation remain unchanged. This integration is not a claim that a
native group run has passed or that a dedicated-host baseline exists.

### Completed timed request outcomes

V3 group observations separate an observed
load/request failure from an incomplete apparatus attempt and from a successful
baseline. It does not diagnose the framework, event loop or underlying cause.
The v2 replay rules remain unchanged; an old partial run cannot acquire v3 proof
or become a new baseline by relabeling its summary or copying its raw metrics.

All functional checks still pass before any timing. Warmup remains strictly
successful. Every requested app/source/pass and fixed/64-user/256-user phase
is retained, including phases after an observed timed request failure. No app,
pass or unsuccessful request is filtered or retried. Request settings, CPU and
memory budgets, duration, warmup, fixed rate and pass count are unchanged.

The k6 producer adds exhaustive counters for successful responses, request
timeouts (native error code 1050), HTTP 429/5xx responses, and invalid/unclassified
responses. HTTP errors may use a different representation, such as Problem JSON
or plain text, but remain failed requests, never successful pages. Unknown transport
errors, other status codes and incorrect content types on 200 responses are not
completed target outcomes. Each active VU initializes all four counter series with
zero once, then increments only the request's classified outcome. This retains
zero-valued categories without four counter updates on every request. A failed
request also adds one to its class: `catalog_failed_http_429`, `_http_502`,
`_http_503` and `_http_5xx` split the HTTP errors, and an invalid response is
`_transport` (k6 got no response for a network reason: a non-TCP network, TCP, TLS or
HTTP/2 error code) or `_other` (a generic, invalid-URL, DNS, blocked-host or
response-decompression error code, another status or a wrong content type). A success
never reaches that classification and no class series receives a sample, so a run
without failures emits exactly the samples it did before the split; k6 reports only
series that received a sample. The six class Counters are still created at init and a
success makes one more comparison; that cost is not measured, and the counters are a timed input
for groups measured from this point (a correctness-only exception, with no performance claim;
saved results are unchanged). A replay reads the classes when any is present, requires
them to account exactly for the HTTP errors and invalid responses, and names a transport
error when it refuses a phase; without any (no failures, or a producer from before the
split) the split is unknown, and the phase replays to the same metrics either way. Any
other series named `catalog_failed_...` is refused, alone or beside the known ones. Counts,
root checks, rates, completed iterations and all three threshold results must
agree exactly. Existing full page/JSON content and browser correctness gates
remain mandatory; timed requests still discard bodies and check status/type,
not full response-body parity under load. Error-response media-type check failures
remain visible and agree exactly with the check totals; successful responses must
still pass the success media-type check. Every positive checker must finish before
the first cold timing starts, across the entire selected group.

Each phase retains `*-boundary.json` (`catalog-timed-phase/v1`): actual Docker
command exit, independent side errors, before/after app/upstream/load identities,
native commands, source environment, mounts, budgets and lifetime state. The
load container must exit normally with code 0 for a passing phase or exactly 99
for independently replayed crossed thresholds. Exit 99 alone proves nothing.
Timeout/cancellation, OOM, restarts, unknown lifecycle, early termination,
counter/sampler/copy errors and incomplete cleanup cannot complete an attempt.
Side errors are preserved together even when k6 has already exited 99.

V3 replay requires a successful `checker.json` boundary for every positive
functional check, including peers of a timed-failed app. Both app and upstream
must retain a valid no-termination state. The full retained lifetime state and
restart count for each participant ID must agree across functional and timed
observations, including the shared upstream. Cumulative CPU windows are checked
by participant ID across all runs and passes in observation-clock order, not
the app/source/pass order in the summary.

Replay checks raw CPU deltas and cumulative continuity, raw/sample agreement,
complete resource windows (no sample gap over two seconds), exact aggregates,
immutable native images and unchanged source/cleanup provenance. App and load
containers cannot be reused across separate runs/phases. Failed phases require
observed load-generator CPU headroom (sampled peak below 80% of its quota);
API-source phases additionally require upstream peak below 80% of one core.
Only fixed-rate phases can retain drops, and they additionally require app
average CPU at least 95% of its quota. These conservative eligibility conditions
do not establish a causal capacity limit.

An observed failure keeps native runner exit 1 and `baseline: false`, while a
complete raw replay returns `attemptComplete: true` and the affected app's
`outcome: "failed"`. That app is never comparison-eligible; fully passing peers
retain their own eligibility. The saved verifier's exit 0 means a complete
replayed attempt, not that every app passed. The strict report command still
exits 1 for a failed baseline. Summary-only reports require an exact failure ledger
derived from retained phases and a matching baseline disposition before labeling
an attempt complete; missing or invented failures remain incomplete. This does
not replace raw replay or retrofit old evidence. Reports expose all phase/pass outcome counts and
median [minimum, maximum] ranges, separating successful req/s from attempted
req/s, request failures and dropped work. Campaign host/source/lifecycle gates
remain independent and unchanged.

### Fixed upstream workers

New explicit group runs write `catalog-saved-evidence/v4` and
`catalog-timed-phase/v2`. The version selects `node-cluster-2/v1`: exactly two
long-lived Node request workers and one coordinator, all inside the unchanged
2-CPU/512-MiB upstream container. Each Node process has a 64-MiB V8 old-space cap;
this is not an increase in container memory. There is no respawn, retry,
adaptive worker count, proxy allocation or app/load budget change. The separate
JSON producer and ungrouped catalog runner do not select this apparatus.

Record GETs retain the encoded-byte fast path and local exact counters. Cluster
distributes connections, not individual HTTP requests over IPC. Administrative
operations alone cross worker IPC. Reset/status/override freezes both workers,
applies one shared epoch, requires both acknowledgements, then releases queued
requests. GET control takes a frozen snapshot and sums each worker once. The
control response adds the epoch, coordinator identity and both worker receipts;
record routes, bodies, status controls and pretty overrides are unchanged.
Missing/late acknowledgement, worker loss, identity change, observation overflow
or bounded administrative/request queue overflow terminates the apparatus.
Readiness requires both listeners; shutdown closes both workers. The separate
POST `/__catalog/observe` endpoint starts/stops bounded phase CPU observations
without resetting or changing ordinary control state.

Each `*-workers.json` binds source, actual upstream container/image/lifetime and
budget to all three roles. Identities use PID, Linux process start ticks, boot ID
and cgroup-v2 identity. Raw samples retain monotonic nanosecond read windows,
wall milliseconds and cumulative `process.cpuUsage()` microseconds. The nominal
interval is 500 ms, with no gap above two seconds; a short final interval is
merged into the preceding interval. Missing windows, counters moving backwards,
epoch changes and churn reject replay, including across source/app/pass boundaries.
Portable test identities cannot qualify native evidence.

On attributed API negatives, each worker AND the coordinator must have sampled
peak CPU strictly below 80% of one core, and upstream container peak must be
strictly below 160%. Aggregate headroom cannot excuse a busy/skewed worker.
On the default four-CPU layout generator peak must stay below 320% wherever
headroom is required; failed warmup, closed-loop drops and
the fixed-drop target-pressure rules are unchanged. Old v2/v3 evidence keeps the
single-process interpretation and its original strict 80% gate, never v4 limits.

After all native correctness checks, before repeated timing, the runner makes
one bounded first-host qualification attempt with the unchanged Corten image:
fixture warmup/sat256, then API warmup/sat256, using the round's existing full
warmup/duration and VU settings. All four must have successful requests, zero
drops, complete worker/container observations, generator and upstream headroom,
and owned app cleanup. These observations live under `preflight/`, never in
official repetitions or aggregates. Failure preserves `preflight.json` and raw
artifacts, exits through ordinary owned cleanup, and stops before repeated timing.
It does not authorize provisioning or claim qualification before a native run.

`apparatus-source.json` lists and hashes the apparatus dependency closure exported
as `apparatusSources`; the campaign still owns the complete application/framework,
image/build and shared source audit. `evidence-index.json` hashes the exact required
replay artifact list exported by `requiredRoundArtifacts`, including first-host
proof, worker observations and `upstream.log`. Replay checks source/index hashes,
native observations, controls, global continuity and every summary aggregate.
V4 command-line reports join this raw replay even without `--require-complete`;
an invalid/missing preflight or index cannot become a complete summary-only report.
A valid timed-negative replay still reports a complete attempt, not a baseline.

Portable bounded checks (synthetic evidence is not native qualification):

```sh
node --max-old-space-size=256 --test --test-concurrency=1 bench/catalog/workers.test.mjs bench/catalog/workers-replay.test.mjs bench/catalog/workers-producer.test.mjs
```

### Explicit catalog-page droplet

The separate `droplet.mjs` controller launches only this group at an explicit full
commit already merged into `origin/main`, from a clean checkout. It does not reuse
the nightly marketplace state or the historical catalog c1 host. Choose an unused
`cN` round above c1 and one durable state root outside the checkout for all these
catalog launches. For example, with operator-supplied values:

```sh
node bench/catalog/droplet.mjs c2 --group catalog-page --commit "$MEASURED_SHA" --ssh-key "$SSH_KEY_ID" --state-dir "$STATE_ROOT" --detach
node bench/catalog/droplet.mjs c2 --group catalog-page --state-dir "$STATE_ROOT" --collect
```

The controller discovers the registry selection and native runner defaults, reserves
the round before creation, and runs on an independently tagged c-8 host without a
persistent local connection. A shared launch lock serializes rounds in that state
root; unresolved reservations block a second launch. Separate roots or machines are
not a distributed lock and must not be used for concurrent launches.

Collection returns 3 while running, 0 for validated complete evidence and confirmed
deletion, 1 for preserved partial evidence and confirmed deletion, or 2 for an error
with recovery state retained. It verifies host/unit ownership, hashes the saved
archive and extracted evidence, and deletes only its terminal owned host after the
durable collection receipt exists. Never clear a live lock or relaunch an ambiguous
reservation. Inspect the exact owning process and retained state first. Interrupted
downloads are preserved rather than overwritten. Evidence stays under the state
root until explicitly reviewed/imported; the controller does not publish results,
change schedules, or certify workload readiness from its fake-cloud tests.

Every selected app must pass checks in both sources before **any** load runs. Checks compare
all 500 JSON records with the fixture, representative pages and filter prefixes with the
contract, and computed styles and element geometry with an independent static reference.
Desktop and phone, light and dark, with and without JavaScript each submit the GET form and
follow a related link. API probes change upstream records between requests, require exactly
one read, reject a forwarded pre-serialized JSON body, and exercise upstream failures.
The Nuxt parity job also checks that the built Home chunk is not requested after hydration
on cold or related catalog routes, but is prefetched after a client transition out of the
catalog. The header opens Home with or without JavaScript and retains keyboard focus
across in-app catalog transitions. Script and stylesheet failures still fail the checker.
`styles.mjs --check` checks all twenty-one stylesheet copies byte-for-byte. After changing
`catalog.css`, run `node bench/catalog/styles.mjs --write` and rebuild the images.

On a quiet, dedicated Linux benchmark host, use a new round name and omit `--check-only`:

```sh
node bench/catalog/run.mjs c2 --build --passes 3
```

Each source, app and target starts a fresh container per pass, measures container-start to
first complete 200 response, warms for 30 seconds, then runs 60-second fixed-rate (150/s),
64-user and 256-user phases. `--duration`, `--warmup`, `--rate` and `--passes` allow bounded
development runs; they are recorded and must match for a comparison. Cold start is **not**
process-exec time: it includes Docker's container startup and the probe's polling interval.
Load requests use identity encoding, no validators and no response-body cache. CPU comes from
the app's cgroup counter, memory and sampled utilization from `docker stats`; raw output,
image IDs, fixture hash, commit and dirty status are retained. An API stand-in's utilization
must also be inspected before attributing a throughput ceiling to an app.

By default the app, load generator and API have CPU quotas of one, four and two cores respectively.
For a dedicated 16-vCPU catalog-page qualification, `CATALOG_LOAD_LAYOUT=c16-generator-v1`
requires the explicit CPU sets `CATALOG_APP_CPUS=1`, `CATALOG_API_CPUS=2-3`, and
`CATALOG_LOAD_CPUS=4-15`. Only the generator quota changes, from four CPUs to twelve.

```sh
CATALOG_LOAD_LAYOUT=c16-generator-v1 CATALOG_APP_CPUS=1 CATALOG_API_CPUS=2-3 CATALOG_LOAD_CPUS=4-15 \
  node bench/catalog/run.mjs c4 --group catalog-page --build --passes 3
```

The runner records the layout and verifies the same strict peak limit (below 80% of
the generator's quota) in preflight and in every timed phase in this layout, including
successful responses. A phase without headroom is not comparison evidence. The browser
checker and first-response probe retain their original four CPUs (4–7), and the
observer keeps its original placement. Wide runs record the cold probe's budget
and sample the running generator's host PID, kernel cgroup membership, effective
CPU set and quota ancestry throughout each phase. Replay rejects a missing window
(more than two seconds) or a restricted sample. These are sampled limits, not
continuous tracing. A requested Docker limit alone is not evidence of available CPUs.
The load profile, request checks and app budget are unchanged.
This opt-in does not select a larger host for the nightly fleet or qualify a mixed-layout
comparison. A wider CPU set without the named layout still has the original four-CPU quota.
By default they are not pinned. For dedicated-host measurements set
`CATALOG_APP_CPUS`, `CATALOG_LOAD_CPUS` and `CATALOG_API_CPUS` to disjoint Docker CPU sets
(for example `0`, `1-4` and `5-6` on an eight-core host). Placement is recorded in the summary;
overlapping sets are rejected. Keep it identical across compared rounds. The API stand-in is
one Node process, not two workers: its two-core quota does not make it use two cores, and high
API CPU can cap HTTP-source throughput independently of the framework.

Results go to `bench/catalog/results/cN/`, which Git ignores: a published round commits its report,
summary and provenance, recording where a maintainer published its raw output, so it can be
fetched, and its SHA-256 ([Benchmark results](../../CONTRIBUTING.md#benchmark-results)). An existing round directory is never overwritten,
including a failed or check-only round. Failures and cleanup errors make the command fail;
only containers and the network with this invocation's ownership label are removed. The
runner does not create cloud machines or operate the fullstack/nightly state. The CI
`Catalog Contract` workflow builds each framework a change selects and runs both of its
sources, but does not publish performance numbers. `scripts/benchmark-scope.mjs` selects them
from the pull request's merge commit against its first parent, or a push to `main` against the
previous tip of `main`: a change to the directory of an app the matrix lists selects that app
and the apps that share a driver it changed (`aspnet-aot` runs the JSON jobs instead), a change
to the framework's Rust inputs (`crates`, `Cargo.toml`, `Cargo.lock`, `.cargo`, the toolchain
files) or to `bench/catalog/corten` selects Corten. The standalone Corten Cargo locks under
`bench/marketplace/corten` and `bench/live/apps/corten`, like the listed fleet-controller files,
select Corten and both JSON jobs. This includes `bench/workloads/fleet.mjs` and its unit
test; the Catalog harness and Benchmark Evidence checks still run. A change to the benchmark's
other shared inputs, to an app directory the matrix does not list yet, or to the workflow
selects them all. A manual run, and a
push whose earlier commit is unknown or not an ancestor, also select them all; a change to none of these builds none
([Checks](../../CONTRIBUTING.md#checks)).

The runner creates the shared upstream container with `--pull=missing`. Docker reuses
the pinned Node image for the requested platform or downloads it within the ten-minute
preparation deadline. The round folder retains the create output in `prepare-upstream.log`.
Starting that same container has a separate 30-second deadline, followed by the
20-second health check. The runner reports preparation and startup failures separately.

The runner uses a version-matched Playwright container for browser checks. Removing its owned
container also removes detached browser processes after a timeout or interruption. To exercise
that Linux cleanup regression locally, run `CATALOG_DOCKER_TESTS=1 node --test
bench/catalog/cleanup.test.mjs` in a shell that supports this environment-variable syntax (or
set the variable separately in PowerShell). The same variable runs the failure receipt's probes
against a real container in `bench/catalog/output.test.mjs`. The ordinary harness tests do not
require Docker.

The opt-in native Gin permission regression builds the real Dockerfile from a Linux
0700-directory/0600-file context and generates fixtures under umask 0077. It retains the
runner's CPU quotas and optional `CATALOG_*_CPUS` placement, native non-root user and complete
fixture/API page, JSON, style and browser checks, then removes its containers, image, volume and network:
`CATALOG_GIN_DOCKER_TESTS=1 node --test bench/catalog/gin-permissions.test.mjs`
(set the variable separately in PowerShell). CI enables it only in the Gin parity job,
not the short harness job. It needs the installed root Playwright dependencies. This is
correctness evidence, not timing or dedicated-host qualification.

For the registry group, saved raw replay can also establish a complete negative attempt
without establishing a baseline. The bounded failure is an observed initial JSON record
response violation, replayed from `checks.json.failure.json` (`record-json-attempt/v1`)
against canonical records. Every started request must have a complete response, the upstream
must be reset/observed healthy, and the owned checker must have normally exited one, without
OOM, timeout or cancellation. `checker.json` retains actual checker/app/upstream identity,
source, CPU/memory and lifetime observations; unrelated image environment is omitted.
Every selected app/source is still checked. Any proven negative gates all group timing;
no successful subset is measured. Saved `validateSaved` verification is raw-attempt
verification, not baseline success: its report exposes `attemptComplete`, per-app `outcomes`
and empty `comparisonEligibleApps` for a negative, with `baseline: false`. The native runner
still exits one. Missing artifacts, browser assertions, network/harness errors, incomplete
cleanup or absent source/host proof cannot be promoted through this path. Other failure
classes remain incomplete until their native observations support equally strict replay.

This first suite measures server rendering, JSON, cold start and CPU/memory under load. Its
browser checks prove parity and functionality, not interactive timing; marketplace build,
byte, instruction and browser-timing tables remain historical. Do not relabel them as catalog
measurements. Before changing the nightly schedule to this workload, merge and pass the
contract workflow, run the full suite on a fresh dedicated host, and establish a reviewed
catalog baseline and reporting path. Do not point the old marketplace summarizer or trend
baseline at these results.
