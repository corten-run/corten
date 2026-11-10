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

No comparative results are published for this workload yet. Its first round establishes a new
baseline. Marketplace rounds `r1` through `r16` must not be described as before measurements of
this page, or mixed into a catalog trend. Framework production settings can still differ;
equal application work is not a claim that their middleware, hydration or transports are equal.

Generate a read-only report from a saved `summary.json`, including preliminary or failed runs:

```sh
node bench/catalog/report.mjs bench/catalog/results/c1/summary.json
node bench/catalog/report.mjs bench/catalog/results/c1/summary.json --commit FULL_MEASURED_SHA --require-complete
```

The second command exits unsuccessfully unless all twenty apps, all requested 64-user passes,
the per-app correctness evidence, canonical fixture identity, measurement configuration,
clean-tree provenance and cleanup succeeded. Supply the full measured
commit, not a branch name. Reports include phase duration, warmup, fixed rate and CPU placement,
label partial pass counts and every app's throughput range, show Corten's CPU efficiency,
memory and latency, and flag underutilized app CPUs or busy single-process
upstreams. A successful correctness baseline is not proof the app saturated its CPU. Inspect
the raw artifacts and `host.txt` as well; the report does not collect results or delete a host.

The proposed [marketplace v2 contract](../marketplace/README.md) retains a richer app workload
while requiring equivalent request-time localization. It is groundwork, not a measured or
ready-to-run replacement for catalog or the historical marketplace suite.

## Running it

From the repository root, with Node 24, Docker and Playwright Chromium installed:

```sh
npm ci
npx playwright install chromium
node bench/catalog/fixtures.mjs
npm run check:catalog
node --test bench/catalog/check.test.mjs
node bench/catalog/run.mjs c1 --build --check-only
```

The default inventory is all twenty page apps in `fullstack/apps.mjs`, not its JSON-only
ASP.NET AOT app. `--apps corten,axum-maud` selects a subset for development. Each app is built
in its existing production image, except Corten's standalone `corten/` app, which uses the
local framework without the marketplace's localized model. Catalog image tags are
`cb-catalog-<app>` so they do not replace the marketplace images.

Every selected app must pass checks in both sources before **any** load runs. Checks compare
all 500 JSON records with the fixture, representative pages and filter prefixes with the
contract, and computed styles and element geometry with an independent static reference.
Desktop and phone, light and dark, with and without JavaScript each submit the GET form and
follow a related link. API probes change upstream records between requests, require exactly
one read, reject a forwarded pre-serialized JSON body, and exercise upstream failures.
`styles.mjs --check` checks all twenty stylesheet copies byte-for-byte. After changing
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

The app, load generator and API have CPU quotas of one, four and two cores respectively.
By default they are not pinned. For dedicated-host measurements set
`CATALOG_APP_CPUS`, `CATALOG_LOAD_CPUS` and `CATALOG_API_CPUS` to disjoint Docker CPU sets
(for example `0`, `1-4` and `5-6` on an eight-core host). Placement is recorded in the summary;
overlapping sets are rejected. Keep it identical across compared rounds. The API stand-in is
one Node process, not two workers: its two-core quota does not make it use two cores, and high
API CPU can cap HTTP-source throughput independently of the framework.

Results go to `bench/catalog/results/cN/`. An existing round directory is never overwritten,
including a failed or check-only round. Failures and cleanup errors make the command fail;
only containers and the network with this invocation's ownership label are removed. The
runner does not create cloud machines or operate the fullstack/nightly state. The CI
`Catalog Contract` workflow builds each framework and runs both sources, but does not publish
performance numbers.

The runner uses a version-matched Playwright container for browser checks. Removing its owned
container also removes detached browser processes after a timeout or interruption. To exercise
that Linux cleanup regression locally, run `CATALOG_DOCKER_TESTS=1 node --test
bench/catalog/cleanup.test.mjs` in a shell that supports this environment-variable syntax (or
set the variable separately in PowerShell). The ordinary harness tests do not require Docker.

This first suite measures server rendering, JSON, cold start and CPU/memory under load. Its
browser checks prove parity and functionality, not interactive timing; marketplace build,
byte, instruction and browser-timing tables remain historical. Do not relabel them as catalog
measurements. Before changing the nightly schedule to this workload, merge and pass the
contract workflow, run the full suite on a fresh dedicated host, and establish a reviewed
catalog baseline and reporting path. Do not point the old marketplace summarizer or trend
baseline at these results.
