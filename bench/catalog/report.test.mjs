import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { allApps } from "../fullstack/apps.mjs";
import { records } from "./fixtures.mjs";
import { inspectCatalog, renderCatalog } from "./report.mjs";

function result() {
  const names = Object.keys(allApps).filter((name) => allApps[name].pages !== false);
  const phase = { rps: 200, perCpuSecond: 220, cpuAvgPct: 99, memMaxMiB: 8, p95: 2, failed: 0, dropped: 0, upstream: { cpuAvgPct: 50, highCpu: false } };
  const check = { jsonRecords: 500, pages: 120, profiles: [false, true].flatMap((javaScriptEnabled) => ["desktop-light", "desktop-dark", "phone-light", "phone-dark"].map((profile) => ({ profile, javaScriptEnabled, forms: true, related: true, styles: true }))),
    upstream: { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true } };
  return { workload: "catalog-v1", round: "c1", commit: "a".repeat(40), dirty: false, complete: true, checksPassed: true,
    fixtureSha256: createHash("sha256").update(`${JSON.stringify(records())}\n`).digest("hex"),
    startedAt: "2026-11-07T16:00:00Z", finishedAt: "2026-11-07T22:00:00Z", failures: [], cleanupFailures: [], options: { apps: names, passes: 3, duration: 60, warmup: 30, rate: 150 },
    measurement: { encoding: "identity", fixedRate: 150, cpus: { app: { quota: 1, cpuset: "0" }, load: { quota: 4, cpuset: "4-7" }, api: { quota: 2, cpuset: "2-3" } } },
    apps: Object.fromEntries(names.map((app) => [app, { checks: { fixture: structuredClone(check), api: structuredClone(check) }, runs: Object.fromEntries(["fixture-page", "fixture-json", "api-page", "api-json"].map((key) => [key,
      [1, 2, 3].map((pass) => ({ pass, complete: true, phases: { sat64: { ...structuredClone(phase), rps: 100 * pass } } }))])) }])) };
}

test("a clean complete result requires all twenty apps and requested passes", () => {
  const report = inspectCatalog(result(), "a".repeat(40));
  assert.equal(report.baseline, true);
  assert.equal(Object.keys(report.apps).length, 20);
  assert.deepEqual(report.apps.corten["fixture-page"].rps, { median: 200, min: 100, max: 300 });
  assert.match(renderCatalog(report), /200 \[100, 300\] \(3\/3\)/);
});

test("historical catalog validation does not acquire group-only provenance or aggregate requirements", () => {
  const s = result();
  assert.equal(s.commitAfter, undefined);
  assert.equal(s.dirtyAfter, undefined);
  assert.equal(s.apps.corten.phases, undefined);
  assert.equal(inspectCatalog(s).baseline, true);
  s.commitAfter = "b".repeat(40);
  s.dirtyAfter = true;
  assert.equal(inspectCatalog(s).baseline, true, "optional new fields do not change legacy validation");
});
test("unfinished, failed, dirty, check-only, missing checks and subset runs are never baselines", () => {
  for (const change of [
    (s) => { delete s.finishedAt; s.complete = false; },
    (s) => { s.finishedAt = "not a timestamp"; },
    (s) => { s.failures.push({ app: "gin", stage: "load", error: "timeout" }); },
    (s) => { s.cleanupFailures.push({ resource: "owned container", error: "busy" }); },
    (s) => { s.dirty = true; }, (s) => { delete s.dirty; },
    (s) => { s.checksPassed = false; }, (s) => { s.options.checkOnly = true; },
    (s) => { delete s.apps.drogon; }, (s) => { s.options.apps.pop(); },
  ]) {
    const s = result(); change(s);
    assert.equal(inspectCatalog(s).baseline, false);
  }
});
test("partial medians show collected passes without turning missing values into zeros", () => {
  const s = result();
  s.apps.corten.runs["fixture-page"].pop();
  delete s.apps.corten.runs["api-json"];
  const report = inspectCatalog(s);
  assert.equal(report.baseline, false);
  assert.equal(report.apps.corten["fixture-page"].rps.median, 150);
  assert.equal(report.apps.corten["api-json"].rps, null);
  assert.match(renderCatalog(report), /150 \[100, 200\] \(2\/3\)/);
  assert.match(renderCatalog(report), /pending/);
});
test("available sat64 from a failed later phase is explicitly partial", () => {
  const s = result();
  s.apps.corten.runs["fixture-page"][0].complete = false;
  s.apps.corten.runs["fixture-page"][0].failed = "sat256 timeout";
  const report = inspectCatalog(s);
  assert.equal(report.baseline, false);
  assert.equal(report.apps.corten["fixture-page"].passes, 3);
  assert.ok(report.warnings.some((s) => /whole run did not complete/.test(s)));
});
test("low application CPU and a busy single-process upstream are limits, not diagnosed causes", () => {
  const s = result();
  s.apps.corten.runs["fixture-json"][0].phases.sat64.cpuAvgPct = 72;
  s.apps.corten.runs["api-json"][0].phases.sat64.upstream.cpuAvgPct = 85;
  const report = inspectCatalog(s);
  assert.equal(report.baseline, true, "limits qualify measurements, not correctness");
  assert.ok(report.warnings.some((s) => /72.0%.*not proven capacity/.test(s)));
  assert.ok(report.warnings.some((s) => /busy single-process upstream/.test(s)));
});
test("missing or invalid CPU/memory metrics cannot certify a baseline", () => {
  for (const [key, value] of [["rps", 0], ["perCpuSecond", null], ["memMaxMiB", NaN], ["p95", -1], ["failed", 1], ["dropped", 1]]) {
    const s = result();
    s.apps.corten.runs["fixture-page"][0].phases.sat64[key] = value;
    assert.equal(inspectCatalog(s).baseline, false, key);
  }
});
test("wrong identity or duplicate pass numbers are rejected", () => {
  assert.throws(() => inspectCatalog(result(), "b".repeat(40)), /commit differs/);
  for (const change of [(s) => { s.workload = "marketplace-v2"; }, (s) => { s.round = "r17"; },
    (s) => { s.apps.corten.runs["fixture-page"][1].pass = 1; }]) {
    const s = result(); change(s);
    assert.throws(() => inspectCatalog(s));
  }
});
test("aggregate correctness flags cannot override missing or contradictory evidence", () => {
  for (const change of [(s) => { delete s.fixtureSha256; }, (s) => { s.fixtureSha256 = "b".repeat(64); },
    (s) => { delete s.apps.corten.checks.api; }, (s) => { s.apps.nextjs.checks.fixture.jsonRecords = 0; },
    (s) => { s.apps.topcoat.checks.api.profiles.pop(); }, (s) => { s.apps.aspnet.checks.fixture.profiles[0].forms = false; },
    (s) => { s.apps.gin.checks.api.upstream.uncachedJson = false; }, (s) => { s.apps.drogon.checks.fixture.pages = 0; },
    (s) => { s.apps.django.checks.fixture.profiles[0] = s.apps.django.checks.fixture.profiles[1]; },
    (s) => { s.apps.django.checks.fixture.profiles[0].javaScriptEnabled = "false"; },
    (s) => { s.apps.corten.checks.fixture.pages = 96; },
    (s) => { s.apps.corten.checks.api.pages = 119; },
    (s) => { s.apps.corten.failures = [{ stage: "load", error: "timeout" }]; }]) {
    const s = result(); change(s); assert.equal(inspectCatalog(s).baseline, false);
  }
});
test("configuration and every competitor's variability remain visible", () => {
  const a = result();
  const before = renderCatalog(inspectCatalog(a));
  assert.match(before, /duration 60 s; warmup 30 s; fixed rate 150 req\/s/);
  assert.match(before, /load \| 4.0 \| 4-7/);
  a.options.duration = 1; a.options.warmup = 1; a.options.rate = 1; a.measurement.fixedRate = 1;
  const after = renderCatalog(inspectCatalog(a));
  assert.notEqual(before, after);
  assert.match(after, /duration 1 s; warmup 1 s; fixed rate 1 req\/s/);
  a.apps.nextjs.runs["fixture-json"].forEach((r, i) => { r.phases.sat64.rps = [1, 200, 10000][i]; });
  assert.match(renderCatalog(inspectCatalog(a)), /nextjs.*200 \[1, 10,000\]/);
  for (const change of [(s) => { delete s.options.duration; }, (s) => { delete s.measurement.cpus.load; },
    (s) => { s.measurement.fixedRate = 42; }, (s) => { s.startedAt = s.finishedAt; s.finishedAt = "2026-11-07T15:00:00Z"; }]) {
    const s = result(); change(s); assert.equal(inspectCatalog(s).baseline, false);
  }
});
test("CPU placement must satisfy the same range, disjointness and quota rules as the runner", () => {
  for (const change of [(s) => { s.measurement.cpus.load.cpuset = "0"; },
    (s) => { s.measurement.cpus.load.cpuset = "7-4"; },
    (s) => { s.measurement.cpus.load.cpuset = "4,4"; },
    (s) => { s.measurement.cpus.load.cpuset = "4096"; },
    (s) => { s.measurement.cpus.load.cpuset = ""; },
    (s) => { s.measurement.cpus.app.quota = 2; }]) {
    const s = result(); change(s); assert.equal(inspectCatalog(s).baseline, false);
  }
  const s = result();
  for (const role of ["app", "load", "api"]) s.measurement.cpus[role].cpuset = null;
  assert.equal(inspectCatalog(s).baseline, true, "unpinned quota-only mode is an explicit supported configuration");
});
